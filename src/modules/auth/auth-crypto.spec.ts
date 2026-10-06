import { PasswordService } from './password.service.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.util.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { loginSchema, registerSchema } from './auth.schemas.js';

describe('PasswordService (real argon2id)', () => {
  const passwords = new PasswordService();

  it('hashes and verifies a password', async () => {
    const hash = await passwords.hash('long-enough-password');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(passwords.verify(hash, 'long-enough-password')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'wrong-password')).resolves.toBe(false);
  }, 15000);

  it('returns false for a malformed stored hash instead of throwing', async () => {
    await expect(passwords.verify('not-a-hash', 'whatever')).resolves.toBe(false);
  });
});

describe('refresh-token util', () => {
  it('generates unique tokens whose hashes are deterministic', () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();

    expect(first).not.toBe(second);
    expect(hashRefreshToken(first)).toBe(hashRefreshToken(first));
    expect(hashRefreshToken(first)).not.toBe(hashRefreshToken(second));
    expect(hashRefreshToken(first)).toHaveLength(64);
  });
});

describe('ZodValidationPipe', () => {
  it('accepts valid register input and rejects short passwords with 400', () => {
    const pipe = new ZodValidationPipe(registerSchema);

    expect(
      pipe.transform({ email: 'ada@example.com', password: 'long-enough-password' }),
    ).toMatchObject({ email: 'ada@example.com' });

    let failure: unknown;
    try {
      pipe.transform({ email: 'ada@example.com', password: 'short' });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 400 });
  });

  it('rejects invalid emails in login input', () => {
    const pipe = new ZodValidationPipe(loginSchema);

    expect(() => pipe.transform({ email: 'not-an-email', password: 'x' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
