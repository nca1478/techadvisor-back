import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';

export interface GoogleProfile {
  email: string;
  name: string | null;
}

/**
 * Verifies Google credentials for sign-in. The only place in the codebase
 * allowed to import `google-auth-library` (same isolation rule as the AI
 * provider adapters). Two credential shapes are supported:
 * - ID tokens (`verify`): signature, issuer, expiry and audience are all
 *   checked by `verifyIdToken`.
 * - OAuth2 access tokens (`verifyAccessToken`): resolved server-side against
 *   the Google userinfo endpoint (no client secret needed); only verified
 *   emails are accepted. This is the shape the custom-styled frontend button
 *   sends: the token popup works on mobile, where One Tap prompts are
 *   unreliable.
 * Every failure maps to a generic 401 so the endpoint never oracles token
 * validity details. Raw tokens are never logged.
 */
@Injectable()
export class GoogleIdTokenVerifier {
  private readonly client = new OAuth2Client();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(idToken: string): Promise<GoogleProfile> {
    const audience = this.config.GOOGLE_CLIENT_ID;
    if (!audience) {
      throw new UnauthorizedException('Google sign-in is not configured');
    }
    let payload: {
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload() ?? {};
    } catch {
      throw new UnauthorizedException('Invalid Google credential');
    }
    if (!payload.email || payload.email_verified === false) {
      throw new UnauthorizedException('Invalid Google credential');
    }
    const name =
      typeof payload.name === 'string' && payload.name.trim() ? payload.name.slice(0, 100) : null;
    return { email: payload.email, name };
  }

  async verifyAccessToken(accessToken: string): Promise<GoogleProfile> {
    if (!this.config.GOOGLE_CLIENT_ID) {
      throw new UnauthorizedException('Google sign-in is not configured');
    }
    let profile: {
      email?: string;
      email_verified?: boolean | string;
      name?: string;
    };
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new UnauthorizedException('Invalid Google credential');
      }
      profile = (await res.json()) as typeof profile;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid Google credential');
    }
    const verified = profile.email_verified === true || profile.email_verified === 'true';
    if (!profile.email || !verified) {
      throw new UnauthorizedException('Invalid Google credential');
    }
    const name =
      typeof profile.name === 'string' && profile.name.trim() ? profile.name.slice(0, 100) : null;
    return { email: profile.email, name };
  }
}
