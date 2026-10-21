import { INSTRUMENT, type NameValidation, validateDisplayName } from '@ome/shared';
import { type SubmitEvent, useEffect, useId, useRef, useState } from 'react';

import type { JoinError, JoinFn } from './join-api.js';
import type { Session } from './session-store.js';

export type JoinNotice = 'expired';

interface JoinScreenProps {
  readonly join: JoinFn;
  readonly onJoined: (session: Session) => void;
  // Why the viewer is back here, if a session just ended.
  readonly notice: JoinNotice | null;
}

const SOURCE_URL = 'https://github.com/CBleakley/order-matching-engine';

const FEATURES = [
  ['Live chart', 'Candles update as trades print'],
  ['Real matching', 'Price-time priority, in C++'],
  ['Your book', 'Orders, fills and P&L'],
] as const;

// The full-screen join card from the design canvas's "Join" artboard.
export function JoinScreen({ join, onJoined, notice }: JoinScreenProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = { heading: useId(), input: useId(), notice: useId(), hint: useId(), error: useId() };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function fail(message: string) {
    setError(message);
    inputRef.current?.focus();
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const checked = checkName(name);
    if (!checked.ok) {
      fail(checked.message);
      return;
    }
    setPending(true);
    setError(null);
    const result = await join(checked.name);
    setPending(false);
    if (result.ok) {
      onJoined(result.session);
    } else {
      fail(joinErrorText(result.error));
    }
  }

  const describedBy = [
    notice === null ? null : ids.notice,
    ids.hint,
    error === null ? null : ids.error,
  ]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <div className="join-page">
      <main className="join">
        <div className="brand">
          <div className="brand__icon">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 3v4M7 17v4M17 6v3M17 19v2" />
              <rect x="4.5" y="7" width="5" height="10" rx="1" />
              <rect x="14.5" y="9" width="5" height="10" rx="1" />
            </svg>
          </div>
          <div className="brand__text">
            <div className="brand__line">
              <span className="brand__symbol">{INSTRUMENT.symbol}</span>
              <span className="brand__tag">Simulated</span>
            </div>
            <span className="brand__name">{INSTRUMENT.name} · Practice market</span>
          </div>
        </div>

        <section aria-labelledby={ids.heading} className="join-card">
          {notice === 'expired' && (
            <p id={ids.notice} role="status" className="join-notice">
              Your session has ended (it expired or the market restarted). Pick a name to join
              again.
            </p>
          )}
          <div className="join-card__intro">
            <h1 id={ids.heading} className="join-card__title">
              Join the practice market
            </h1>
            <p className="join-card__text">
              {INSTRUMENT.symbol} is a simulated stock. Everyone here trades against simulated
              traders and against each other. No real money, no sign-up.
            </p>
          </div>
          <form className="join-form" noValidate onSubmit={(event) => void submit(event)}>
            <div className="field">
              <label htmlFor={ids.input} className="field__label">
                Display name
              </label>
              <input
                ref={inputRef}
                id={ids.input}
                className="field__input"
                type="text"
                autoComplete="nickname"
                placeholder="e.g. Alex Morgan"
                value={name}
                aria-invalid={error !== null}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
              <span id={ids.hint} className="field__hint">
                2–20 characters: letters, numbers, spaces, - and _. Only you see it.
              </span>
            </div>
            {error !== null && (
              <p id={ids.error} role="alert" className="field__error">
                {error}
              </p>
            )}
            <button type="submit" className="button-primary" aria-disabled={pending}>
              {pending ? 'Joining…' : 'Start trading'}
            </button>
          </form>
        </section>

        <ul className="join-features">
          {FEATURES.map(([title, text]) => (
            <li key={title} className="join-feature">
              <span className="join-feature__title">{title}</span>
              <span className="join-feature__text">{text}</span>
            </li>
          ))}
        </ul>

        <p className="join-footer">
          How it works: <a href={SOURCE_URL}>source on GitHub</a>
        </p>
      </main>
    </div>
  );
}

// The gateway's own rules, checked before submitting so most mistakes never
// leave the browser. A valid name comes back normalized, as the gateway stores it.
function checkName(raw: string): NameValidation {
  if (raw.trim() === '') return { ok: false, message: 'Enter a display name.' };
  const result = validateDisplayName(raw);
  return result.ok ? result : { ok: false, message: sentence(result.message) };
}

// The gateway's name messages have no full stop; the rest of the screen's do.
function sentence(message: string): string {
  return message.endsWith('.') ? message : `${message}.`;
}

export function joinErrorText(error: JoinError): string {
  switch (error.kind) {
    case 'invalidName':
      return sentence(error.message);
    case 'rateLimited':
      return error.retryAfterSeconds === null
        ? 'Too many join attempts. Try again shortly.'
        : `Too many join attempts. Try again in ${String(error.retryAfterSeconds)} seconds.`;
    case 'engineUnavailable':
      return 'The market is unavailable right now. Try again shortly.';
    case 'network':
      return 'Couldn’t reach the server. Check your connection and try again.';
  }
}
