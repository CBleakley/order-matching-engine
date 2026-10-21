// A recording stand-in for Lightweight Charts' createChart: jsdom has no
// canvas, so component tests check what the chart was told to draw instead.
// Tests install it with vi.mock('lightweight-charts', ...) as createChart.
import type { CreatePriceLineOptions, MouseEventParams } from 'lightweight-charts';

type Options = Record<string, unknown>;

function isPlainObject(value: unknown): value is Options {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Merges like the real applyOptions: nested option groups merge, not replace.
function mergeOptions(target: Options, source: Options): Options {
  const merged: Options = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? mergeOptions(current, value) : value;
  }
  return merged;
}

export class FakePriceLine {
  constructor(public options: CreatePriceLineOptions) {}
  applyOptions(options: Partial<CreatePriceLineOptions>): void {
    this.options = { ...this.options, ...options };
  }
}

export class FakeSeries {
  readonly calls: { method: 'setData' | 'update'; data: unknown }[] = [];
  readonly priceLines: FakePriceLine[] = [];
  options: Record<string, unknown>;

  constructor(
    readonly type: string,
    options: Record<string, unknown> = {},
  ) {
    this.options = { ...options };
  }

  setData(data: unknown[]): void {
    this.calls.push({ method: 'setData', data });
  }
  update(data: unknown): void {
    this.calls.push({ method: 'update', data });
  }
  applyOptions(options: Record<string, unknown>): void {
    this.options = mergeOptions(this.options, options);
  }
  priceScale() {
    return { applyOptions: () => undefined };
  }
  createPriceLine(options: CreatePriceLineOptions): FakePriceLine {
    const line = new FakePriceLine(options);
    this.priceLines.push(line);
    return line;
  }
  removePriceLine(line: FakePriceLine): void {
    const index = this.priceLines.indexOf(line);
    if (index !== -1) this.priceLines.splice(index, 1);
  }
}

export class FakeChart {
  readonly series: FakeSeries[] = [];
  removed = false;
  options: Record<string, unknown>;
  private crosshairHandlers: ((param: MouseEventParams) => void)[] = [];

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
  }

  addSeries(definition: { type: string }, options?: Record<string, unknown>): FakeSeries {
    const series = new FakeSeries(definition.type, options);
    this.series.push(series);
    return series;
  }
  removeSeries(series: FakeSeries): void {
    const index = this.series.indexOf(series);
    if (index !== -1) this.series.splice(index, 1);
  }
  applyOptions(options: Record<string, unknown>): void {
    this.options = mergeOptions(this.options, options);
  }
  priceScale() {
    return { applyOptions: () => undefined };
  }
  timeScale() {
    return { setVisibleLogicalRange: () => undefined };
  }
  subscribeCrosshairMove(handler: (param: MouseEventParams) => void): void {
    this.crosshairHandlers.push(handler);
  }
  unsubscribeCrosshairMove(handler: (param: MouseEventParams) => void): void {
    this.crosshairHandlers = this.crosshairHandlers.filter((h) => h !== handler);
  }
  remove(): void {
    this.removed = true;
  }

  moveCrosshair(param: Partial<MouseEventParams>): void {
    for (const handler of this.crosshairHandlers) handler({ seriesData: new Map(), ...param });
  }

  seriesOfType(type: string): FakeSeries | undefined {
    return this.series.find((s) => s.type === type);
  }
}

// Every chart created, newest last.
export const charts: FakeChart[] = [];

export function liveChart(): FakeChart {
  const chart = charts.filter((c) => !c.removed).at(-1);
  if (chart === undefined) throw new Error('no live chart');
  return chart;
}

export function fakeCreateChart(_container: unknown, options?: Record<string, unknown>): FakeChart {
  const chart = new FakeChart(options);
  charts.push(chart);
  return chart;
}
