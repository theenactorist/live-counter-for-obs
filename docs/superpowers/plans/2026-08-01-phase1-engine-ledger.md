# SDD ledger — plan: docs/superpowers/plans/2026-08-01-phase1-engine.md
Task 1.1: minor (deferred): npm audit reports transitive dev-dep advisories (vitest/vite subtree) — verify before broad toolchain reuse
Task 1.1: complete (commits d387d7b..9effa6f, review clean)
Task 1.2: minor (deferred): no test for completion.seconds type-check when kind !== holdThenHide (types.ts:122 correct by inspection)
Task 1.2: complete (commits 9effa6f..bc71495, review clean)
Task 1.3: plan correction accepted (controller ruling): brief cap-test loop 25 pushes inconsistent with asserted survivor value 4; implementer corrected to 24, cap+FIFO invariant still tested
Task 1.3: fix round 1/5 (2 addressed, 0 open — isCompletionConfig shared from types.ts; completion shallow-copied; commits 99adde7..9728698)
Task 1.3: complete (commits bc71495..9728698, review clean after fix round 1)
Task 1.4: complete (commit c416dac, jump/reverse/reset implemented and passing; no plan corrections needed)
Task 1.4: minor (deferred): undo-entry push pattern triplicated across move/jump/reverse (counter.ts:97-120) — pushUndo helper would DRY it
Task 1.4: minor (deferred): reverse-no-animate test lacks accepted:true assertion; no jump-onto-boundary-via-change test; no automatic-mode coverage for corrections
Task 1.4: complete (commits 9728698..c416dac, review clean)
Task 1.5: minor (deferred): non-null assertion at counter.ts:130 (stylistic); animate-effects ternary duplicated between undo and reset
Task 1.5: complete (commits c416dac..785f09c, review clean)
Task 1.6: minor (deferred): self-review overclaims (overlay re-show asserted only for auto-move+reverse; purity freeze test covers move only)
Task 1.6: minor (deferred → folded into Task 1.9 scope): add regression tests for undo-exiting-complete, jump-exiting-complete, tick-at-opposite-boundary rejection reason, setMode manual→auto from complete
Task 1.6: DESIGN NOTE for Phase 2 (controller-confirmed): status is path-dependent — persistence must STORE status, never re-derive from (value,direction) on rehydrate
Task 1.6: DESIGN NOTE for Phase 2 (controller-confirmed): dock timer must issue pause on tick rejection — reverse-at-0 while running yields steady rejected-tick spin (engine-correct, dock's job to stop)
Task 1.6: controller ruling confirmed: reversed session completing at the start-side boundary (e.g. 0→50 reversed, reaches 0) is INTENDED per PRD §8.5 active-boundary definition
Task 1.6: complete (commits 785f09c..45c55fa, review clean)
Task 1.7: plan correction accepted (controller ruling): brief sleep-test line Math.min→Math.max — min variant could not detect the gap (FakeRuntime resets now to due.at+7); max matches the stated intent; verified by hand-trace and reviewer
Task 1.7: minor (deferred): RED evidence lives in report files only (single commit per task) — acceptable per report contract
Task 1.7: complete (commits 45c55fa..338cbfc, review clean)
Task 1.8: minor (deferred): direction-invariance test is conceptual duplicate of AC16 case (format.test.ts:63-69) — could be a real swapped-triple check
Task 1.8: complete (commits 338cbfc..5f97b79, review clean)
Task 1.9: minor (parked with ruling): endSession absent from replaySeed/property command menus — INTENDED: endSession is terminal (callers discard the session), replaying past it exercises states Phase 2 never runs; brief's own arbitrary set the same scope
Task 1.9: complete (commits 5f97b79..6b787c4, review clean)
All 9 tasks complete — proceeding to final whole-branch review
Final review: 3-lens workflow (state-machine/plan-compliance/test-quality) + adversarial verify → 10 confirmed majors (6 distinct), 13 minors; fix wave 0d20c85 addressed all 7 fix items; scoped re-review: ALL ADDRESSED, no new Critical/Important breakage
Parked (ruling): timer `running` reads true inside onTick after stop() until hook returns — only bites a stop-then-setInterval-same-tick hook shape Phase 2 does not use; close when Phase 2 wires AutoTimer (one line: clear firing in stop or split the flag)
Parked (ruling): sleep-threshold 2s-floor mutant survives — floor is defensive; add 0.25s-interval threshold test when timer next touched
Deferred minors (final-review triage: all OK-TO-DEFER): property invariants one-directional; isSession cross-field looseness; interval-ladder split; format placebo/vacuous tests; endSession-from-complete untested; shared fixtures; NonceWindow default-capacity test; loadPresets 'null' literal wording note for Phase 2 warnings
Phase 2 carry-forwards: hiddenByCompletion Session field (overlay re-show residual); store status, never re-derive; dock pauses on tick rejection AND on completed effect
Phase 1 COMPLETE: 161/161 tests, typecheck clean, final review clean after 1 fix wave
