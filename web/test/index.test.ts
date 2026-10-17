import { describe, expect, it } from 'vitest';

import { WEB_DEPENDENCIES, WEB_PACKAGE } from '../src/index.js';

describe('@ome/web', () => {
  it('exports its package name and resolves @ome/shared', () => {
    expect(WEB_PACKAGE).toBe('@ome/web');
    expect(WEB_DEPENDENCIES).toEqual(['@ome/shared']);
  });
});
