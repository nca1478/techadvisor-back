import { describe, expect, it } from 'vitest';
import { excerpt, groupQueries, normalizeQuery } from './query-normalize.js';

describe('normalizeQuery', () => {
  it('folds near-duplicate abstentions into the same key', () => {
    expect(normalizeQuery('¿Cuánto dura la batería?')).toBe('cuanto dura la bateria');
    expect(normalizeQuery('cuanto dura la bateria')).toBe('cuanto dura la bateria');
    expect(normalizeQuery('  CUÁNTO   dura... ¡la BATERÍA!  ')).toBe('cuanto dura la bateria');
  });

  it('returns empty for punctuation-only questions (dropped from groups)', () => {
    expect(normalizeQuery('¿...?!')).toBe('');
  });

  it('caps the key length so buckets stay bounded', () => {
    expect(normalizeQuery('a'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('groupQueries', () => {
  const rows = [
    { text: '¿Cuánto dura la batería?', at: new Date('2026-10-09T10:00:00Z') },
    { text: 'cuanto dura la bateria', at: new Date('2026-10-10T10:00:00Z') },
    { text: '¿Tiene garantía?', at: new Date('2026-10-08T10:00:00Z') },
  ];

  it('buckets by normalized text, most frequent first', () => {
    const groups = groupQueries(
      rows,
      (row) => row.text,
      (row) => row.at,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.key).toBe('cuanto dura la bateria');
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.sample).toBe('¿Cuánto dura la batería?');
    expect(groups[0]?.latestAt).toBe('2026-10-10T10:00:00.000Z');
    expect(groups[1]?.count).toBe(1);
  });

  it('skips rows that normalize to empty instead of grouping them', () => {
    const groups = groupQueries(
      [{ text: '??', at: new Date() }],
      (row) => row.text,
      (row) => row.at,
    );
    expect(groups).toHaveLength(0);
  });
});

describe('excerpt', () => {
  it('keeps short texts untouched and cuts long ones with an ellipsis', () => {
    expect(excerpt('  hola  ', 200)).toBe('hola');
    const cut = excerpt('x'.repeat(500), 200);
    expect(cut.length).toBeLessThanOrEqual(201);
    expect(cut.endsWith('…')).toBe(true);
  });
});
