// Shared threshold: how long the dock waits, after losing (or never having
// gained) an identified connection, before calling it "not connected" rather
// than "still trying". main.ts's banner-ws (Task 2.5) and live.ts's Connect
// card (Task 2.12) both need this SAME number so the two surfaces never
// visibly disagree about when a connection attempt has gone on "too long" —
// previously two hand-synced `3000` literals (review fold-in, Minor: one
// owner instead of two copies that could drift).
export const CONNECTION_GRACE_MS = 3000;
