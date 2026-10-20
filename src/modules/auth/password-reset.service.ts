import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MAIL_PROVIDER, type MailProvider } from '../mail/mail.interface.js';
import { passwordChangedMail, resetCodeMail } from '../mail/templates/password-reset.templates.js';
import { UsersService } from '../users/users.service.js';
import { PasswordService } from './password.service.js';
import type {
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  PasswordResetVerifyInput,
} from './password-reset.schemas.js';

/**
 * OTP password-reset for LOCAL users. Anti-enumeration: `request` always
 * answers `{ ok: true }`; mails go out only for LOCAL users with a password.
 * OTP and resetToken are high-entropy randoms — only SHA-256 hashes persist.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /**
   * Starts an OTP challenge. Unknown emails answer 404; registered accounts
   * without a local password (e.g. Google sign-in) answer 409 — the message
   * never reveals the provider, only that the password cannot be changed
   * (see ADR 0078: explicit product decision, trades away anti-enumeration
   * on this endpoint).
   */
  async request(input: PasswordResetRequestInput): Promise<{ ok: true }> {
    const email = input.email.trim().toLowerCase();
    const candidate = await this.users.findByEmailWithHash(email);
    if (candidate === null) {
      throw new NotFoundException('Email not registered');
    }
    if (candidate.provider !== 'LOCAL' || candidate.passwordHash === null) {
      throw new ConflictException('Password cannot be changed for this account');
    }

    // Opportunistic purge: drop this user's dead challenges (consumed or
    // unusable) so the table stays bounded even if the admin cleanup
    // trigger never runs.
    await this.deleteDeadChallenges(candidate.id, new Date());

    const cooldownMs = this.config.PASSWORD_RESET_REQUEST_COOLDOWN_SEC * 1000;
    const recent = await this.prisma.passwordReset.findFirst({
      where: { userId: candidate.id, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < cooldownMs) {
      throw new HttpException(
        'Code already sent. Please wait before retrying.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(0, 10 ** this.config.PASSWORD_RESET_OTP_LENGTH)).padStart(
      this.config.PASSWORD_RESET_OTP_LENGTH,
      '0',
    );
    await this.prisma.passwordReset.create({
      data: {
        userId: candidate.id,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + this.config.PASSWORD_RESET_OTP_TTL_MIN * 60_000),
      },
    });

    const support = this.config.MAIL_REPLY_TO ?? 'soporte@example.com';
    try {
      const mail = resetCodeMail({
        code,
        ttlMin: this.config.PASSWORD_RESET_OTP_TTL_MIN,
        supportEmail: support,
      });
      await this.mail.send({ to: email, ...mail });
    } catch {
      throw new ServiceUnavailableException('Could not send the reset code. Try again later.');
    }
    return { ok: true as const };
  }

  async verify(
    input: PasswordResetVerifyInput,
  ): Promise<{ resetToken: string; expiresIn: number }> {
    const email = input.email.trim().toLowerCase();
    const candidate = await this.users.findByEmailWithHash(email);
    if (candidate === null) {
      throw new BadRequestException('Invalid code');
    }
    const challenge = await this.prisma.passwordReset.findFirst({
      where: { userId: candidate.id, consumedAt: null, verifiedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired code');
    }
    if (challenge.attempts >= this.config.PASSWORD_RESET_MAX_ATTEMPTS) {
      throw new BadRequestException('Invalid or expired code');
    }
    if (sha256(input.code) !== challenge.codeHash) {
      await this.prisma.passwordReset.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid code');
    }

    const resetToken = randomBytes(32).toString('base64url');
    const expiresIn = this.config.PASSWORD_RESET_TOKEN_TTL_MIN * 60;
    await this.prisma.passwordReset.update({
      where: { id: challenge.id },
      data: {
        verifiedAt: new Date(),
        resetTokenHash: sha256(resetToken),
        resetTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      },
    });
    return { resetToken, expiresIn };
  }

  async confirm(input: PasswordResetConfirmInput): Promise<{ ok: true }> {
    const email = input.email.trim().toLowerCase();
    const candidate = await this.users.findByEmailWithHash(email);
    if (candidate === null) {
      throw new BadRequestException('Invalid reset token');
    }
    const challenge = await this.prisma.passwordReset.findFirst({
      where: {
        userId: candidate.id,
        resetTokenHash: sha256(input.resetToken),
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      !challenge ||
      !challenge.resetTokenExpiresAt ||
      challenge.resetTokenExpiresAt.getTime() <= Date.now() ||
      !challenge.verifiedAt
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.users.setPassword(candidate.id, input.password, this.passwords);
    await this.prisma.passwordReset.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date(), resetTokenHash: null },
    });

    const support = this.config.MAIL_REPLY_TO ?? 'soporte@example.com';
    try {
      const mail = passwordChangedMail({ supportEmail: support });
      await this.mail.send({ to: email, ...mail });
    } catch {
      // Password already changed; a failed notice mail must not fail reset.
    }
    return { ok: true as const };
  }

  /**
   * Retention purge (admin job trigger): deletes challenges that can never
   * be used again — consumed ones, and expired OTPs whose reset token is
   * absent or expired. Verified challenges with a live reset token survive.
   */
  async cleanupExpired(now: Date = new Date()): Promise<{ deleted: number }> {
    return this.deleteDeadChallenges(undefined, now);
  }

  private async deleteDeadChallenges(
    userId: string | undefined,
    now: Date,
  ): Promise<{ deleted: number }> {
    const result = await this.prisma.passwordReset.deleteMany({
      where: {
        ...(userId ? { userId } : {}),
        OR: [
          { consumedAt: { not: null } },
          { expiresAt: { lt: now }, resetTokenHash: null },
          { expiresAt: { lt: now }, resetTokenExpiresAt: { lt: now } },
        ],
      },
    });
    return { deleted: result.count };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
