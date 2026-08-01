// Tiny reactive store shared by the dock and overlay pages. No framework:
// `get()` returns the current immutable state object, `set()` shallow-merges
// a patch (only ever replacing the top-level object when something actually
// changed), and `subscribe()` registers a listener that fires with the new
// state after every effective `set()`.

export function createStore<T extends object>(
  initial: T,
): { get(): T; set(patch: Partial<T>): void; subscribe(fn: (s: T) => void): () => void } {
  let state = initial;
  const subscribers = new Set<(s: T) => void>();

  function get(): T {
    return state;
  }

  function set(patch: Partial<T>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (!Object.is(state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    state = { ...state, ...patch };

    // Iterate the live Set (not a snapshot): a subscriber that unsubscribes
    // itself, or another not-yet-visited subscriber, during this notification
    // must not break delivery to the remaining ones. `Set`'s own iterator
    // handles concurrent `delete()` safely (an entry removed before its turn
    // is simply skipped; entries already visited, or still to come, are
    // unaffected) — see tests/protocol/store.test.ts for the exact contract.
    for (const fn of subscribers) {
      fn(state);
    }
  }

  function subscribe(fn: (s: T) => void): () => void {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  return { get, set, subscribe };
}
