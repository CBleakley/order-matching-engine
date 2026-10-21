import { useSession } from '../session/session-context.js';
import type { AppState } from '../state/app-state.js';
import { useAppState } from '../state/store.js';

const selectMe = (state: AppState) => state.me;

// The viewer's display name and the Leave action, in the header.
export function UserBadge() {
  const session = useSession();
  const me = useAppState(selectMe);
  if (session === null) return null;

  const name = me?.name ?? session.name;
  return (
    <div className="user-badge">
      <span className="user-badge__avatar" aria-hidden="true">
        {initial(name)}
      </span>
      <span className="user-badge__name">{name}</span>
      <button type="button" className="user-badge__leave" onClick={session.leave}>
        Leave
      </button>
    </div>
  );
}

// Names are letters, digits, space, - and _ (no combining marks), so the first
// code point is the whole first character.
function initial(name: string): string {
  const first = name.codePointAt(0);
  return first === undefined ? '' : String.fromCodePoint(first).toUpperCase();
}
