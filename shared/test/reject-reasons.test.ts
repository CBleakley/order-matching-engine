import { describe, expect, it } from 'vitest';

import { REJECT_REASON_TEXT, REJECT_REASONS, rejectReasonSchema } from '../src/reject-reasons.js';

describe('REJECT_REASON_TEXT', () => {
  it('has text for exactly the documented reasons', () => {
    expect(Object.keys(REJECT_REASON_TEXT).sort()).toEqual([...REJECT_REASONS].sort());
  });

  it.each(REJECT_REASONS)('has non-empty text for %s', (reason) => {
    expect(REJECT_REASON_TEXT[reason].trim()).not.toBe('');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(REJECT_REASON_TEXT)).toBe(true);
  });
});

describe('rejectReasonSchema', () => {
  it.each(REJECT_REASONS)('accepts %s', (reason) => {
    expect(rejectReasonSchema.safeParse(reason).success).toBe(true);
  });

  it.each(['', 'PriceOutOfRange', 'unknown', 3])('rejects %j', (reason) => {
    expect(rejectReasonSchema.safeParse(reason).success).toBe(false);
  });
});
