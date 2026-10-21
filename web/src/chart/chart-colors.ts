// The chart draws on a canvas, so it cannot use CSS variables directly. These
// read the design tokens from tokens.css and re-read them when the viewer
// switches palette (settings/palette.ts sets data-palette on the root element).
import { useEffect, useState } from 'react';

export interface ChartColors {
  readonly up: string;
  readonly down: string;
  readonly background: string;
  readonly grid: string;
  readonly border: string;
  readonly text: string;
  readonly crosshair: string;
}

// Used when a token is missing, as in tests without tokens.css.
export const FALLBACK_COLORS: ChartColors = {
  up: '#26c281',
  down: '#f2546b',
  background: '#11141b',
  grid: '#181c26',
  border: '#1e2330',
  text: '#8e96a8',
  crosshair: '#8fa8ff',
};

const TOKENS: Readonly<Record<keyof ChartColors, string>> = {
  up: '--color-up',
  down: '--color-down',
  background: '--color-panel',
  grid: '--color-chart-grid',
  border: '--color-border',
  text: '--color-text-4',
  crosshair: '--color-accent',
};

export function readChartColors(root: HTMLElement = document.documentElement): ChartColors {
  const style = getComputedStyle(root);
  const read = (key: keyof ChartColors) =>
    style.getPropertyValue(TOKENS[key]).trim() || FALLBACK_COLORS[key];
  return {
    up: read('up'),
    down: read('down'),
    background: read('background'),
    grid: read('grid'),
    border: read('border'),
    text: read('text'),
    crosshair: read('crosshair'),
  };
}

// "#26c281" at the given opacity, for the volume bars.
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) return hex;
  const value = Number.parseInt(match[1] ?? '0', 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})`;
}

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => readChartColors());
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setColors((current) => {
        const next = readChartColors(root);
        const same = (Object.keys(next) as (keyof ChartColors)[]).every(
          (key) => next[key] === current[key],
        );
        return same ? current : next;
      });
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-palette'] });
    return () => {
      observer.disconnect();
    };
  }, []);
  return colors;
}
