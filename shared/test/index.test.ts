import { describe, expect, it } from 'vitest';

import { SHARED_PACKAGE } from '../src/index.js';

describe('@ome/shared', () => {
  it('exports its package name', () => {
    expect(SHARED_PACKAGE).toBe('@ome/shared');
  });
});
