import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing with argon2id (PHC string format, includes salt and
 * parameters). Timing-safe comparison is handled inside `argon2.verify`.
 * Passwords and hashes are never logged.
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Malformed stored hash: treat as non-match, never leak internals.
      return false;
    }
  }
}
