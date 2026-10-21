// Display name rules, enforced by the gateway and checked by the web join
// screen before it submits. Names are only shown to their owner in Phase 1, so
// they need not be unique; they only need to be short and plain.
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 20;

// Unicode letters (after NFC, so precomposed accents count as one letter),
// ASCII digits, space, '-' and '_'.
const NAME_PATTERN = /^[\p{L}0-9 _-]+$/u;
// With the u flag, `.` matches a code point, so this counts code points rather
// than UTF-16 units.
const NAME_LENGTH_PATTERN = new RegExp(
  `^.{${String(MIN_NAME_LENGTH)},${String(MAX_NAME_LENGTH)}}$`,
  'su',
);

export type NameValidation =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

export function validateDisplayName(raw: unknown): NameValidation {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'Name must be a string' };
  }
  const name = raw.normalize('NFC').trim();
  if (!NAME_LENGTH_PATTERN.test(name)) {
    return {
      ok: false,
      message: `Name must be ${String(MIN_NAME_LENGTH)}–${String(MAX_NAME_LENGTH)} characters`,
    };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, message: 'Name may only contain letters, digits, spaces, - and _' };
  }
  return { ok: true, name };
}
