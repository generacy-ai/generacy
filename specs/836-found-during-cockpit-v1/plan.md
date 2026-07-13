# Implementation Plan: `cockpit watch` must survive its own poll interval

**Feature**: Remove `timer.unref()` in the `sleep()` helper so `generacy cockpit watch` stays alive across poll intervals.
**Branch**: `836-found-during-cockpit-v1`
**Status**: Complete

## Summary

`packages/generacy/src/cli/commands/cockpit/watch.ts` calls `timer.unref?.()` on the sleep timer between polls. An unref'd timer does not keep Node's event loop alive, so after the first poll settles and the loop awaits the interval sleep, the process exits 0 mid-sleep. The abort path (SIGINT/SIGTERM/`deps.abortSignal`) is already sound, so removing the single `timer.unref?.()` line is the whole fix.

A subprocess-driven regression test (spawns the compiled `generacy` CLI, awaits the startup line, asserts the child is still alive ~5 s later, then SIGTERMs and asserts exit 0) is the sole regression gate — per Q1 in `clarifications.md`, in-process `runWatch` + `onTick` tests structurally cannot catch this bug class under vitest because the runner's own handles keep the event loop alive.

## Technical Context

- **Language / Runtime**: TypeScript, Node.js >=22, ESM
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`)
- **Test framework**: vitest
- **Dependencies changed**: none
- **Public API changed**: none (`WatchDeps` unchanged; no `unrefTimer` flag added — deferred per Q2)
- **New build artifacts required**: the subprocess test needs the compiled CLI (`dist/bin/generacy.js`) to exist at test time — either invoke `pnpm build` before the test in CI, or run against `tsx` on the source. The existing generacy package test scripts already build first; the regression test will follow the same convention.

## Files Touched

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/cockpit/watch.ts` | Remove `timer.unref?.()` at ~line 55. Add one-line comment referencing #836 explaining why (satisfies FR-002). |
| `packages/generacy/src/cli/commands/cockpit/__tests__/watch-subprocess.test.ts` (new) | Spawn compiled CLI with a fixture epic ref, await startup line on stderr, sleep ~5 s, assert child still alive, SIGTERM, assert exit 0. Must NOT inject `abortSignal` and must NOT run in-process. |

Nothing else changes. `runOnePoll`, `snapshot.ts`, `emit.ts`, `resolver.ts`, and the `WatchDeps` shape are all untouched.

## Fix Detail

Current (buggy):

```ts
const timer = setTimeout(resolve, ms);
timer.unref?.();  // <-- process can drain here between polls
```

After fix:

```ts
// Do not unref — see #836. An embedder that needs an unref'd timer must gate
// it behind an explicit WatchDeps flag the CLI never sets.
const timer = setTimeout(resolve, ms);
```

The abort listener on `signal` is retained unchanged — that's what makes SIGINT/SIGTERM/`deps.abortSignal` still exit promptly (FR-003).

## Regression Test Detail

Per Q1's amendment, the test asserts the "process stays alive through the first sleep" property — not "≥ 2 poll ticks":

1. `spawn` (`node:child_process`) the compiled `generacy` CLI: `node dist/bin/generacy.js cockpit watch <fixture-epic-ref>`.
2. Attach a stderr listener; resolve a Promise when the `cockpit watch: epic ...` startup line appears.
3. `await` that Promise (timeout 15 s — network/`gh` resolution can be slow).
4. `await` 5 s more (`setTimeout` in the parent process, referenced — the parent is vitest, its loop is alive regardless).
5. Assert `child.exitCode === null` and `child.killed === false` (child is still running).
6. `child.kill('SIGTERM')`.
7. `await` child close event; assert exit code is 0.

The fixture epic ref should be a real, small, stable epic in a public repo (or a canary repo controlled by the org). If a stable public fixture isn't available, the test can be scoped to CI-only (`skip` locally when `CI` env var is unset) and consume `GH_TOKEN` from CI secrets. Given SC-002 caps runtime at ~10 s and `resolveEpic` needs to succeed against a live epic, using a stable public issue in `generacy-ai/generacy` (e.g., a closed low-noise reference issue) is the pragmatic choice.

The white-box `hasRef()` assertion mentioned as optional in Q1 is not included in this plan — Q1 says "allowed but not required," and the subprocess test alone satisfies FR-004 and SC-002.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no explicit constitution to check against. General project conventions honored:

- **Small, surgical diff** (CLAUDE.md: "Don't add features, refactor, or introduce abstractions beyond what the task requires"). One line removed, one line of comment added, one new test file.
- **No comments on obvious code, only WHY** (CLAUDE.md): the added inline comment explains WHY `unref` is absent, references the issue, and states the constraint for future embedders — WHY, not WHAT.
- **Don't add error handling for scenarios that can't happen** (CLAUDE.md): the abort path is unchanged; no new error branches introduced.
- **No backwards-compat shims**: no `WatchDeps.unrefTimer` flag, no deprecation layer. Q2 explicitly defers this to when a real embedder appears.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| A hidden embedder relies on the current unref (unknown-unknown). | Assumptions section of spec asserts none found via grep. Public `WatchDeps` shape is unchanged — only the internal `sleep()` timer behavior differs, and any embedder that isn't `unref`-dependent sees no change. |
| Subprocess test flakes on slow CI networks (5 s check races with slow `gh` resolution). | The startup line prints AFTER `resolveEpic` succeeds, so the 5 s clock starts post-resolution — network latency shifts the total test runtime but not the alive-check window. |
| Subprocess test requires the CLI to be built. | Follow the existing generacy package convention (`pnpm build && pnpm test`), or run the test against `tsx packages/generacy/src/cli/index.ts` if `dist/` isn't present. |

## Suggested Next Step

`/speckit:tasks` to generate the ordered task list.
