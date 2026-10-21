import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { JoinFn, JoinResult } from '../src/session/join-api.js';
import { type JoinNotice, JoinScreen } from '../src/session/JoinScreen.js';
import type { Session } from '../src/session/session-store.js';

const SESSION: Session = { token: 'payload.signature', traderId: 1_000_001, name: 'Ada' };

function renderJoin(
  join: JoinFn = vi.fn<JoinFn>(() => Promise.resolve({ ok: true, session: SESSION })),
  notice: JoinNotice | null = null,
) {
  const onJoined = vi.fn<(session: Session) => void>();
  render(<JoinScreen join={join} onJoined={onJoined} notice={notice} />);
  const input = screen.getByLabelText('Display name');
  const button = screen.getByRole('button', { name: 'Start trading' });
  return { join, onJoined, input, button };
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

// Submits the way Enter in the name field does: the browser submits the form.
async function pressEnter(input: HTMLElement) {
  const form = input.closest('form');
  if (form === null) throw new Error('input is not in a form');
  await act(async () => {
    fireEvent.submit(form);
    await Promise.resolve();
  });
}

describe('JoinScreen', () => {
  it('explains the market and asks for a display name', () => {
    renderJoin();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Join the practice market' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/trades against simulated traders/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'source on GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('supports a keyboard-only flow', async () => {
    const { input, button, join, onJoined } = renderJoin();
    // Focus starts in the labelled field, and Tab reaches the submit button next.
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(/2–20 characters/);
    expect(input.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(button).toHaveAttribute('type', 'submit');
    expect(button.closest('form')).toBe(input.closest('form'));

    type(input, 'Ada');
    await pressEnter(input);
    expect(join).toHaveBeenCalledWith('Ada');
    expect(onJoined).toHaveBeenCalledWith(SESSION);
  });

  it.each([
    ['', 'Enter a display name.'],
    ['   ', 'Enter a display name.'],
    ['A', 'Name must be 2–20 characters.'],
    ['a'.repeat(21), 'Name must be 2–20 characters.'],
    ['hi!', 'Name may only contain letters, digits, spaces, - and _.'],
  ])('rejects %j without contacting the server', async (name, message) => {
    const { input, join } = renderJoin();
    type(input, name);
    await pressEnter(input);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(expect.stringContaining(message) as string);
    expect(input).toHaveFocus();
    expect(join).not.toHaveBeenCalled();
  });

  it('clears the error when the name is edited', async () => {
    const { input } = renderJoin();
    await pressEnter(input);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    type(input, 'A');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('submits the trimmed, normalized name with the button', async () => {
    const { input, button, join, onJoined } = renderJoin();
    type(input, '  Zoë  ');
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(join).toHaveBeenCalledWith('Zoë');
    expect(onJoined).toHaveBeenCalledWith(SESSION);
  });

  it('submits once while a join is in flight', async () => {
    let resolve: (result: JoinResult) => void = () => undefined;
    const join = vi.fn<JoinFn>(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { input, button, onJoined } = renderJoin(join);
    type(input, 'Ada');
    await pressEnter(input);
    expect(button).toHaveTextContent('Joining…');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await pressEnter(input);
    expect(join).toHaveBeenCalledOnce();

    await act(async () => {
      resolve({ ok: true, session: SESSION });
      await Promise.resolve();
    });
    expect(onJoined).toHaveBeenCalledOnce();
  });

  it.each<[JoinResult, string]>([
    [
      { ok: false, error: { kind: 'invalidName', message: 'Name must be 2–20 characters' } },
      'Name must be 2–20 characters.',
    ],
    [
      { ok: false, error: { kind: 'rateLimited', retryAfterSeconds: 30 } },
      'Too many join attempts. Try again in 30 seconds.',
    ],
    [
      { ok: false, error: { kind: 'rateLimited', retryAfterSeconds: null } },
      'Too many join attempts. Try again shortly.',
    ],
    [
      { ok: false, error: { kind: 'engineUnavailable' } },
      'The market is unavailable right now. Try again shortly.',
    ],
    [
      { ok: false, error: { kind: 'network' } },
      'Couldn’t reach the server. Check your connection and try again.',
    ],
  ])('shows the server error %j inline', async (result, message) => {
    const { input, button, onJoined } = renderJoin(vi.fn<JoinFn>(() => Promise.resolve(result)));
    type(input, 'Ada');
    await pressEnter(input);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(input).toHaveFocus();
    expect(button).toHaveTextContent('Start trading');
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('explains that an expired session must join again', () => {
    const { input } = renderJoin(undefined, 'expired');
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/session has ended/);
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining('session has ended') as string,
    );
  });
});
