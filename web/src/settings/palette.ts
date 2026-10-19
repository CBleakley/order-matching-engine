// The up/down colour palette, a per-browser user setting. "blue-orange" is the
// design's alternative for colour-blind visitors; tokens.css switches the
// --color-up / --color-down tokens on the root element's data-palette attribute.
import { useCallback, useState } from 'react';

export type Palette = 'green-red' | 'blue-orange';

export const DEFAULT_PALETTE: Palette = 'green-red';
export const PALETTE_STORAGE_KEY = 'nova.palette';

function isPalette(value: unknown): value is Palette {
  return value === 'green-red' || value === 'blue-orange';
}

// Storage can be missing or throw (private windows, blocked site data), so
// every access falls back to the default instead of failing.
export function loadPalette(): Palette {
  try {
    const stored = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPalette(stored) ? stored : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function savePalette(palette: Palette): void {
  try {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // Not persisted; the setting still applies for this page view.
  }
}

export function applyPalette(palette: Palette, root: HTMLElement = document.documentElement): void {
  root.dataset['palette'] = palette;
}

export function usePalette(): [Palette, (palette: Palette) => void] {
  const [palette, setPaletteState] = useState<Palette>(loadPalette);
  const setPalette = useCallback((next: Palette) => {
    applyPalette(next);
    savePalette(next);
    setPaletteState(next);
  }, []);
  return [palette, setPalette];
}
