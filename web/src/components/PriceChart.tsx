import { INSTRUMENT, type Interval, INTERVALS } from '@ome/shared';
import { useCallback, useId, useRef, useState } from 'react';

import { useChartColors } from '../chart/chart-colors.js';
import { tooltipContent } from '../chart/tooltip.js';
import { type ChartHover, useCandleChart } from '../chart/use-candle-chart.js';
import { useGateway } from '../connection/gateway-context.js';
import type { AppState } from '../state/app-state.js';
import { useAppState } from '../state/store.js';

const selectInterval = (state: AppState) => state.interval;
const selectCandles = (state: AppState) => state.candles;
const selectOpenOrders = (state: AppState) => state.openOrders;
const selectInstrument = (state: AppState) => state.instrument;

// Gap between the cursor and the tooltip, in px.
const TOOLTIP_OFFSET = 16;

// The live candlestick chart from the design canvas: interval selector, chart
// with the viewer's order lines and hover tooltip, and legend.
export function PriceChart() {
  const interval = useAppState(selectInterval);
  const candles = useAppState(selectCandles);
  const openOrders = useAppState(selectOpenOrders);
  const instrument = useAppState(selectInstrument) ?? INSTRUMENT;
  const gateway = useGateway();
  const colors = useChartColors();
  // The interval the viewer last asked for. It shows as pressed until the
  // gateway's snapshot (or any other snapshot, after a reconnect) changes the
  // store's interval.
  const [requested, setRequested] = useState<Interval | null>(null);
  const [seenInterval, setSeenInterval] = useState(interval);
  if (interval !== seenInterval) {
    setSeenInterval(interval);
    setRequested(null);
  }
  const [showVolume, setShowVolume] = useState(false);
  const [hover, setHover] = useState<ChartHover | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalLabelId = useId();

  const decimals = instrument.priceDecimals;
  useCandleChart(containerRef, {
    interval,
    candles,
    openOrders,
    decimals,
    colors,
    showVolume,
    onHover: setHover,
  });

  const selected = requested ?? interval;

  const chooseInterval = useCallback(
    (next: Interval) => {
      if (gateway === null || next === selected) return;
      if (gateway.setInterval(next)) setRequested(next);
    },
    [gateway, selected],
  );

  const tip =
    hover !== null && interval !== null ? tooltipContent(hover.bar, interval, decimals) : null;
  const tipOnLeft = hover !== null && hover.x > hover.width / 2;

  return (
    <div className="chart">
      <div className="chart__toolbar">
        <div className="chart__intervals">
          <span className="chart__toolbar-label" id={intervalLabelId}>
            Interval
          </span>
          <div className="segmented" role="group" aria-labelledby={intervalLabelId}>
            {INTERVALS.map((option) => (
              <button
                key={option}
                type="button"
                className="segmented__option num"
                aria-pressed={option === selected}
                onClick={() => {
                  chooseInterval(option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="chart__toggle"
            aria-pressed={showVolume}
            onClick={() => {
              setShowVolume((on) => !on);
            }}
          >
            Volume
          </button>
        </div>
        <span className="num chart__caption">
          {instrument.symbol}
          {selected === null ? '' : ` · ${selected} candles`} · local time
        </span>
      </div>

      <div className="chart__frame">
        <div
          ref={containerRef}
          className="chart__canvas"
          role="img"
          aria-label={`${instrument.symbol} candlestick chart`}
          onMouseLeave={() => {
            setHover(null);
          }}
        />
        {interval === null ? <div className="chart__waiting">Waiting for market data…</div> : null}
        {tip !== null && hover !== null ? (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={
              tipOnLeft
                ? { right: hover.width - hover.x + TOOLTIP_OFFSET }
                : { left: hover.x + TOOLTIP_OFFSET }
            }
          >
            <div className="chart-tooltip__head">
              <span className="num">{tip.time}</span>
              <span
                className={`num chart-tooltip__change chart-tooltip--${tip.up ? 'up' : 'down'}`}
              >
                {tip.change}
              </span>
            </div>
            <dl className="chart-tooltip__grid">
              <dt>Open</dt>
              <dd className="num">{tip.open}</dd>
              <dt>High</dt>
              <dd className="num">{tip.high}</dd>
              <dt>Low</dt>
              <dd className="num">{tip.low}</dd>
              <dt>Close</dt>
              <dd className={`num chart-tooltip--${tip.up ? 'up' : 'down'}`}>{tip.close}</dd>
              <dt>Range</dt>
              <dd className="num">{tip.range}</dd>
              <dt>Trades</dt>
              <dd className="num">{tip.trades}</dd>
              <dt>Volume</dt>
              <dd className="num">{tip.volume}</dd>
            </dl>
          </div>
        ) : null}
      </div>

      <div className="chart__legend">
        <span className="chart__legend-item">
          <span className="swatch swatch--up" aria-hidden="true" />
          Close ≥ open
        </span>
        <span className="chart__legend-item">
          <span className="swatch swatch--down" aria-hidden="true" />
          Close &lt; open
        </span>
        <span>Dashed lines mark your resting orders. Hover a candle for details.</span>
      </div>
    </div>
  );
}
