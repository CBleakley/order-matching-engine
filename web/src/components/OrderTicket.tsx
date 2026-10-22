import { formatMoney, formatQty, INSTRUMENT, type Side, ticksToDecimalString } from '@ome/shared';
import { type SubmitEvent, useId, useState } from 'react';

import { useGateway } from '../connection/gateway-context.js';
import { NO_VALUE } from '../orders/format.js';
import type { AppState } from '../state/app-state.js';
import { useAppState, useStore } from '../state/store.js';
import { estimatedValueTicks, validateOrderForm } from '../ticket/order-form.js';
import { submissionText } from '../ticket/submission-text.js';

const selectConnection = (state: AppState) => state.connection;
const selectInstrument = (state: AppState) => state.instrument;
const selectLast = (state: AppState) => state.stats?.last ?? null;
const selectSubmission = (state: AppState) => state.orderSubmission;

const DEFAULT_QTY = '100';

// The "Place order" panel from the design canvas: a limit order for the
// viewer's own session (identity comes from the session, so there is no name
// field). Inputs are checked here with the gateway's rules before sending;
// the gateway's reply, and what happened to the order on arrival, appear in
// the status line.
export function OrderTicket() {
  const gateway = useGateway();
  const store = useStore();
  const connection = useAppState(selectConnection);
  const instrument = useAppState(selectInstrument) ?? INSTRUMENT;
  const last = useAppState(selectLast);
  const submission = useAppState(selectSubmission);

  const [side, setSide] = useState<Side>('buy');
  const [qtyText, setQtyText] = useState(DEFAULT_QTY);
  const [priceText, setPriceText] = useState('');
  // Errors show once a field has been left, or after a submit attempt.
  const [qtyTouched, setQtyTouched] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const id = useId();
  const qtyId = `${id}-qty`;
  const priceId = `${id}-price`;
  const qtyErrorId = `${id}-qty-error`;
  const priceErrorId = `${id}-price-error`;
  const noticeId = `${id}-notice`;

  const live = connection.kind === 'live' && gateway !== null;
  const sending = submission?.outcome.kind === 'sending';
  const form = validateOrderForm(qtyText, priceText, instrument);
  const qtyError = attempted || qtyTouched ? form.qtyError : null;
  const priceError = attempted || priceTouched ? form.priceError : null;
  const price = (ticks: number) => ticksToDecimalString(ticks, instrument);
  const estimate =
    form.qty !== null && form.priceTicks !== null
      ? formatMoney(estimatedValueTicks(form.qty, form.priceTicks), instrument)
      : NO_VALUE;
  const status = submission === null ? null : submissionText(submission, instrument.priceDecimals);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!live || sending) return;
    setAttempted(true);
    if (form.qty === null || form.priceTicks === null) return;
    const order = {
      clientOrderId: crypto.randomUUID(),
      side,
      qty: form.qty,
      priceTicks: form.priceTicks,
    };
    if (gateway.placeOrder(order)) {
      store.dispatch({ type: 'orderSubmitted', order });
      setAttempted(false);
    }
  }

  let submitLabel = side === 'buy' ? 'Place buy order' : 'Place sell order';
  if (!live) submitLabel = 'Waiting for connection…';
  else if (sending) submitLabel = 'Sending…';

  return (
    <form className={`ticket ticket--${side}`} onSubmit={submit} noValidate>
      <fieldset
        className="ticket__fields"
        disabled={!live}
        aria-describedby={live ? undefined : noticeId}
      >
        <legend className="visually-hidden">New limit order</legend>
        <div className="ticket__sides" role="group" aria-label="Order side">
          {(['buy', 'sell'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`ticket__side ticket__side--${option}`}
              aria-pressed={side === option}
              onClick={() => {
                setSide(option);
              }}
            >
              {option === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>

        <div className="ticket__inputs">
          <div className="field">
            <label htmlFor={qtyId} className="field__label">
              Quantity
            </label>
            <input
              id={qtyId}
              className="num field__input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={qtyText}
              aria-invalid={qtyError !== null}
              aria-describedby={qtyError === null ? undefined : qtyErrorId}
              onChange={(event) => {
                setQtyText(event.target.value);
              }}
              onBlur={() => {
                setQtyTouched(true);
              }}
            />
            {qtyError !== null && (
              <p id={qtyErrorId} className="field__error">
                {qtyError}
              </p>
            )}
          </div>

          <div className="field">
            <div className="ticket__label-row">
              <label htmlFor={priceId} className="field__label">
                Limit price
              </label>
              <button
                type="button"
                className="ticket__use-last"
                disabled={last === null}
                onClick={() => {
                  if (last === null) return;
                  setPriceText(price(last));
                  setPriceTouched(true);
                }}
              >
                Use last
              </button>
            </div>
            <input
              id={priceId}
              className="num field__input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder={last === null ? undefined : price(last)}
              value={priceText}
              aria-invalid={priceError !== null}
              aria-describedby={priceError === null ? undefined : priceErrorId}
              onChange={(event) => {
                setPriceText(event.target.value);
              }}
              onBlur={() => {
                setPriceTouched(true);
              }}
            />
            {priceError !== null && (
              <p id={priceErrorId} className="field__error">
                {priceError}
              </p>
            )}
          </div>
        </div>

        <div className="ticket__estimate">
          <span>Estimated value</span>
          <span className="num ticket__estimate-value" data-testid="estimated-value">
            {estimate}
          </span>
        </div>

        <button type="submit" className="ticket__submit" disabled={sending}>
          {submitLabel}
        </button>
      </fieldset>

      {!live && (
        <p id={noticeId} className="ticket__notice">
          Order entry is paused until the connection is restored.
        </p>
      )}

      {/* Keyed by order, so a repeated identical message is announced again. */}
      {status !== null &&
        submission !== null &&
        (status.tone === 'error' ? (
          <p
            key={submission.clientOrderId}
            role="alert"
            className="ticket__status ticket__status--error"
          >
            {status.text}
          </p>
        ) : (
          <p key={submission.clientOrderId} role="status" className="ticket__status">
            {status.text}
          </p>
        ))}

      <p className="ticket__limits">
        Limits: up to {formatQty(instrument.maxOrderQty)} shares per order, prices in steps of{' '}
        {instrument.tickSize}.
      </p>
    </form>
  );
}
