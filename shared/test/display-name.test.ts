import { describe, expect, it } from 'vitest';

import { validateDisplayName } from '../src/display-name.js';

describe('validateDisplayName', () => {
  it.each([
    ['Al', 'Al'],
    ['  Ada Lovelace  ', 'Ada Lovelace'],
    ['trader_42', 'trader_42'],
    ['first-last', 'first-last'],
    ['Seán Ó Briain', 'Seán Ó Briain'],
    ['Zoë', 'Zoë'],
    ['東京トレーダー', '東京トレーダー'],
    ['a'.repeat(20), 'a'.repeat(20)],
  ])('accepts %j as %j', (raw, name) => {
    expect(validateDisplayName(raw)).toEqual({ ok: true, name });
  });

  it('normalizes to NFC, so a decomposed accent counts as one letter', () => {
    const decomposed = 'Zoë'; // e + combining diaeresis
    const result = validateDisplayName(decomposed);
    expect(result).toEqual({ ok: true, name: 'Zoë' });
  });

  it('counts length in code points', () => {
    // 20 astral letters (2 UTF-16 units each) are within the limit.
    expect(validateDisplayName('𝐀'.repeat(20)).ok).toBe(true);
    expect(validateDisplayName('𝐀'.repeat(21)).ok).toBe(false);
  });

  it.each(['', '   ', 'a', ' a ', 'a'.repeat(21)])('rejects %j as the wrong length', (raw) => {
    expect(validateDisplayName(raw)).toEqual({
      ok: false,
      message: 'Name must be 2–20 characters',
    });
  });

  it.each(['<script>', 'hi!', 'a.b', 'emoji 🚀', 'tab\there', 'new\nline', 'a@b', 'x\u0000y'])(
    'rejects %j for its characters',
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({
        ok: false,
        message: 'Name may only contain letters, digits, spaces, - and _',
      });
    },
  );

  it.each([undefined, null, 42, ['Al'], { name: 'Al' }])('rejects non-string %j', (raw) => {
    expect(validateDisplayName(raw)).toEqual({ ok: false, message: 'Name must be a string' });
  });
});
