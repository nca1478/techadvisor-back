import {
  newSignedSid,
  parseCookies,
  serializeClearedSidCookie,
  serializeSidCookie,
  signSessionId,
  verifySignedSid,
} from './guest-session.js';

const SECRET = 'test-secret-at-least-16-chars';

describe('signed guest sessions', () => {
  it('round-trips a fresh session id', () => {
    const { sessionId, signed } = newSignedSid(SECRET);
    expect(verifySignedSid(signed, SECRET)).toBe(sessionId);
  });

  it('rejects tampered, foreign-secret and malformed values', () => {
    const { signed } = newSignedSid(SECRET);
    const [id = '', mac = ''] = signed.split('.');
    expect(verifySignedSid(`${id}.x${mac.slice(1)}`, SECRET)).toBeNull();
    expect(verifySignedSid(signSessionId(id, 'other-secret'), SECRET)).toBeNull();
    for (const bad of [
      undefined,
      '',
      'plain-uuid',
      'a.b.c',
      `${id}.short`,
      `not hex here.${'0'.repeat(64)}`,
    ]) {
      expect(verifySignedSid(bad, SECRET)).toBeNull();
    }
  });

  it('binds the signature to the secret', () => {
    const { sessionId, signed } = newSignedSid(SECRET);
    expect(signSessionId(sessionId, SECRET)).toBe(signed);
    expect(signSessionId(sessionId, 'another-secret')).not.toBe(signed);
  });
});

describe('cookie helpers', () => {
  it('parses the Cookie header without dependencies', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('sid=abc.def; other=1')).toEqual({ sid: 'abc.def', other: '1' });
    expect(parseCookies('  sid = abc.def ')).toEqual({ sid: 'abc.def' });
    expect(parseCookies('empty=; sid=abc.def')).toEqual({ sid: 'abc.def' });
  });

  it('serializes httpOnly sid cookies (set and clear)', () => {
    const set = serializeSidCookie('id.mac');
    expect(set).toContain('sid=id.mac');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Path=/');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Max-Age=');

    const cleared = serializeClearedSidCookie();
    expect(cleared).toContain('sid=;');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
  });
});
