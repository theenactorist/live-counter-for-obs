import { describe, expect, it } from 'vitest';
import { createStore } from '../../src/shared/store.js';

interface Fixture {
  count: number;
  name: string;
}

describe('createStore', () => {
  it('get() returns the initial state', () => {
    const store = createStore<Fixture>({ count: 0, name: 'a' });
    expect(store.get()).toEqual({ count: 0, name: 'a' });
  });

  it('set() shallow-merges a patch, updates get(), and notifies subscribers with the new state', () => {
    const store = createStore<Fixture>({ count: 0, name: 'a' });
    const seen: Fixture[] = [];
    store.subscribe((s) => seen.push(s));

    store.set({ count: 1 });

    expect(store.get()).toEqual({ count: 1, name: 'a' });
    expect(seen).toEqual([{ count: 1, name: 'a' }]);
  });

  it('does not notify when an identical patch changes nothing (shallow-equal per patched key)', () => {
    const store = createStore<Fixture>({ count: 1, name: 'a' });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });

    store.set({ count: 1 }); // same value as current state
    store.set({}); // empty patch
    store.set({ count: 1, name: 'a' }); // both fields identical

    expect(calls).toBe(0);
    expect(store.get()).toEqual({ count: 1, name: 'a' });
  });

  it('still notifies when at least one patched key actually changes', () => {
    const store = createStore<Fixture>({ count: 1, name: 'a' });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });

    store.set({ count: 1, name: 'b' }); // count same, name differs

    expect(calls).toBe(1);
    expect(store.get()).toEqual({ count: 1, name: 'b' });
  });

  it('unsubscribe() stops further notifications to that subscriber', () => {
    const store = createStore<Fixture>({ count: 0, name: 'a' });
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls++;
    });

    store.set({ count: 1 });
    unsub();
    store.set({ count: 2 });

    expect(calls).toBe(1);
    expect(store.get()).toEqual({ count: 2, name: 'a' });
  });

  it('a subscriber unsubscribing itself mid-notification does not break other subscribers, this round or later', () => {
    const store = createStore<Fixture>({ count: 0, name: 'a' });
    const order: string[] = [];

    const unsubA = store.subscribe(() => {
      order.push('a');
      unsubA();
    });
    store.subscribe(() => {
      order.push('b');
    });

    store.set({ count: 1 });
    expect(order).toEqual(['a', 'b']);

    order.length = 0;
    store.set({ count: 2 });
    // a unsubscribed itself last round; only b fires now.
    expect(order).toEqual(['b']);
  });

  it('unsubscribing a not-yet-called subscriber from within an earlier one does not error, and later subscribers still run', () => {
    const store = createStore<Fixture>({ count: 0, name: 'a' });
    const order: string[] = [];
    let unsubB: () => void = () => {};

    store.subscribe(() => {
      order.push('a');
      unsubB();
    });
    unsubB = store.subscribe(() => {
      order.push('b');
    });
    store.subscribe(() => {
      order.push('c');
    });

    expect(() => store.set({ count: 1 })).not.toThrow();
    // b was unsubscribed before its turn; c still ran.
    expect(order).toEqual(['a', 'c']);
  });
});
