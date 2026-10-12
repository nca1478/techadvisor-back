import { updateProfileSchema } from './users.schemas.js';

describe('updateProfileSchema', () => {
  it('accepts a name-only update', () => {
    const result = updateProfileSchema.safeParse({ name: 'Ada Lovelace' });
    expect(result.success).toBe(true);
  });

  it('accepts a password-only update', () => {
    const result = updateProfileSchema.safeParse({ password: 'correct-horse-battery-staple-42' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty body (at least one field is required)', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a short password', () => {
    expect(updateProfileSchema.safeParse({ password: 'short' }).success).toBe(false);
  });

  it('strips email so it can never be updated through this endpoint', () => {
    const result = updateProfileSchema.safeParse({
      name: 'Ada Lovelace',
      email: 'new@example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('email');
      expect(result.data.name).toBe('Ada Lovelace');
    }
  });
});
