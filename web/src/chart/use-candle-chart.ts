// Owns one Lightweight Charts instance for the lifetime of a container element
// and keeps it in step with the store: candles, the viewer's order lines,
// volume, palette and formatting. The series are created once; live bars go
// through series.update, so the chart never rebuilds on a `candles` message.
import type { CandleBar, Interval, OrderView } from '@ome/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { type RefObject, useEffect, useRef } from 'react';

import { type ChartColors, withAlpha } from './chart-colors.js';
import { orderLineOptions } from './order-lines.js';
import {
  chartTimeToMs,
  formatAxisTime,
  formatLocalTime,
  planSeriesUpdate,
  priceFormatter,
  toCandle,
  toChartTime,
  toVolume,
} from './series-data.js';

export interface CandleChartInput {
  readonly interval: Interval | null;
  readonly candles: readonly CandleBar[];
  readonly openOrders: readonly OrderView[];
  readonly decimals: number;
  readonly colors: ChartColors;
  readonly showVolume: boolean;
  // Called with the hovered bar and the cursor's x within the chart, or null.
  readonly onHover: (hover: ChartHover | null) => void;
}

export interface ChartHover {
  readonly bar: CandleBar;
  readonly x: number;
  readonly width: number;
}

const FONT_FAMILY = "'Geist Mono', ui-monospace, monospace";
const VOLUME_SCALE = 'volume';
const VOLUME_ALPHA = 0.35;
// Candles keep clear of the volume histogram along the bottom when it is shown.
const CANDLE_MARGINS = { top: 0.1, bottom: 0.1 };
const CANDLE_MARGINS_WITH_VOLUME = { top: 0.1, bottom: 0.25 };
const BAR_SPACING = 8;
const RIGHT_OFFSET = 4;

interface ChartParts {
  readonly container: HTMLElement;
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'> | null;
  readonly orderLines: Map<number, IPriceLine>;
  // What the series currently shows, for planSeriesUpdate.
  shownBars: readonly CandleBar[];
  shownInterval: Interval | null;
  shownDecimals: number | null;
  // For the crosshair handler: bars by chart time (UTC seconds).
  readonly barsByTime: Map<number, CandleBar>;
}

function volumeColors(colors: ChartColors) {
  return { up: withAlpha(colors.up, VOLUME_ALPHA), down: withAlpha(colors.down, VOLUME_ALPHA) };
}

export function useCandleChart(
  containerRef: RefObject<HTMLElement | null>,
  input: CandleChartInput,
): void {
  const { interval, candles, openOrders, decimals, colors, showVolume } = input;
  const partsRef = useRef<ChartParts | null>(null);
  // Effects and chart callbacks read the latest input through a ref, so the
  // chart is not torn down and rebuilt whenever an input changes. Declared
  // first, so it runs before the effects below.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  // Create the chart once per container.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const { colors: initialColors } = latest.current;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: initialColors.background },
        textColor: initialColors.text,
        fontFamily: FONT_FAMILY,
        fontSize: 11,
        // Required by the Lightweight Charts licence.
        attributionLogo: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, rightOffset: RIGHT_OFFSET, barSpacing: BAR_SPACING },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceLineWidth: 1,
    });
    const parts: ChartParts = {
      container,
      chart,
      candles: candleSeries,
      volume: null,
      orderLines: new Map(),
      shownBars: [],
      shownInterval: null,
      shownDecimals: null,
      barsByTime: new Map(),
    };
    partsRef.current = parts;

    const handleCrosshair = (param: MouseEventParams) => {
      // The chart only ever holds UTCTimestamp (number) times.
      const bar = typeof param.time === 'number' ? parts.barsByTime.get(param.time) : undefined;
      latest.current.onHover(
        bar === undefined || param.point === undefined
          ? null
          : { bar, x: param.point.x, width: container.clientWidth },
      );
    };
    chart.subscribeCrosshairMove(handleCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshair);
      chart.remove();
      partsRef.current = null;
    };
  }, [containerRef]);

  // Palette and theme.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null) return;
    const line = { color: colors.border, labelBackgroundColor: colors.border };
    parts.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border },
      crosshair: { vertLine: line, horzLine: line },
    });
    parts.candles.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    parts.volume?.setData(parts.shownBars.map((bar) => toVolume(bar, volumeColors(colors))));
  }, [colors]);

  // Price formatting from the instrument.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null) return;
    parts.chart.applyOptions({ localization: { priceFormatter: priceFormatter(decimals) } });
    parts.candles.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals },
    });
  }, [decimals]);

  // Time formatting for the interval, in local time.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null || interval === null) return;
    parts.chart.applyOptions({
      localization: { timeFormatter: (time: Time) => formatLocalTime(chartTimeToMs(time)) },
      timeScale: {
        secondsVisible: interval === '5s' || interval === '15s',
        tickMarkFormatter: (time: Time) => formatAxisTime(chartTimeToMs(time), interval),
      },
    });
  }, [interval]);

  // Volume histogram, created and removed with the toggle.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null) return;
    if (!showVolume) {
      parts.candles.priceScale().applyOptions({ scaleMargins: CANDLE_MARGINS });
      return;
    }
    const volume = parts.chart.addSeries(HistogramSeries, {
      priceScaleId: VOLUME_SCALE,
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    parts.chart.priceScale(VOLUME_SCALE).applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    parts.candles.priceScale().applyOptions({ scaleMargins: CANDLE_MARGINS_WITH_VOLUME });
    volume.setData(
      parts.shownBars.map((bar) => toVolume(bar, volumeColors(latest.current.colors))),
    );
    parts.volume = volume;
    return () => {
      parts.volume = null;
      // The chart may already be gone if the component is unmounting.
      if (partsRef.current === parts) parts.chart.removeSeries(volume);
    };
  }, [showVolume]);

  // Candles: live bars update in place; anything else reloads the series.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null) return;
    const plan =
      interval !== parts.shownInterval || decimals !== parts.shownDecimals
        ? { kind: 'reset' as const }
        : planSeriesUpdate(parts.shownBars, candles);
    const volColors = volumeColors(latest.current.colors);
    if (plan.kind === 'reset') {
      parts.candles.setData(candles.map((bar) => toCandle(bar, decimals)));
      parts.volume?.setData(candles.map((bar) => toVolume(bar, volColors)));
      parts.barsByTime.clear();
      for (const bar of candles) parts.barsByTime.set(toChartTime(bar.start), bar);
      // Show the newest bars at the usual spacing, or stretch a short history
      // across the whole width.
      const fit = Math.max(1, Math.floor(parts.container.clientWidth / BAR_SPACING));
      parts.chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - fit),
        to: candles.length - 1 + RIGHT_OFFSET,
      });
    } else if (plan.kind === 'update') {
      for (const bar of plan.bars) {
        parts.candles.update(toCandle(bar, decimals));
        parts.volume?.update(toVolume(bar, volColors));
        parts.barsByTime.set(toChartTime(bar.start), bar);
      }
    }
    parts.shownBars = candles;
    parts.shownInterval = interval;
    parts.shownDecimals = decimals;
  }, [candles, interval, decimals]);

  // The viewer's resting orders as dashed price lines, keyed by order ID.
  useEffect(() => {
    const parts = partsRef.current;
    if (parts === null) return;
    const lineColors = { up: colors.up, down: colors.down };
    const live = new Set<number>();
    for (const order of openOrders) {
      live.add(order.orderId);
      const options = orderLineOptions(order, decimals, lineColors);
      const line = parts.orderLines.get(order.orderId);
      if (line === undefined) {
        parts.orderLines.set(order.orderId, parts.candles.createPriceLine(options));
      } else {
        line.applyOptions(options);
      }
    }
    for (const [orderId, line] of parts.orderLines) {
      if (!live.has(orderId)) {
        parts.candles.removePriceLine(line);
        parts.orderLines.delete(orderId);
      }
    }
  }, [openOrders, decimals, colors]);

  // Hides a tooltip for a bar that the chart no longer shows.
  useEffect(() => {
    latest.current.onHover(null);
  }, [interval]);
}
