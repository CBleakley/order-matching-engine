import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyPalette,
  DEFAULT_PALETTE,
  loadPalette,
  PALETTE_STORAGE_KEY,
  savePalette,
} from '../src/settings/palette.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('palette setting', () => {
  it('defaults to green / red when nothing is saved', () => {
    expect(loadPalette()).toBe(DEFAULT_PALETTE);
    expect(DEFAULT_PALETTE).toBe('green-red');
  });

  it('round-trips through localStorage', () => {
    savePalette('blue-orange');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('blue-orange');
    expect(loadPalette()).toBe('blue-orange');
  });

  it('ignores an unknown saved value', () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'purple');
    expect(loadPalette()).toBe(DEFAULT_PALETTE);
  });

  it('falls back to the default when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(loadPalette()).toBe(DEFAULT_PALETTE);
  });

  it('does not throw when saving fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => {
      savePalette('blue-orange');
    }).not.toThrow();
  });

  it('sets data-palette on the given element', () => {
    const element = document.createElement('div');
    applyPalette('blue-orange', element);
    expect(element.dataset['palette']).toBe('blue-orange');
  });
});
