import { describe, expect, it } from 'vitest';

import { GATEWAY_DEPENDENCIES, GATEWAY_PACKAGE } from '../src/index.js';

describe('@ome/gateway', () => {
  it('exports its package name and resolves @ome/shared', () => {
    expect(GATEWAY_PACKAGE).toBe('@ome/gateway');
    expect(GATEWAY_DEPENDENCIES).toEqual(['@ome/shared']);
  });
});
