# Implementation Plan: Fix smee.io provisioner to match live `/new` behavior (#965)

**Feature**: Change `SmeeChannelResolver.provision()` from `POST` + strict `status === 302` to `GET` + broad 3xx range (`>= 300 && < 400`) with `Location` re-validated against `SMEE_URL_PATTERN`. Reword the rejection diagnostic to `"expected 3xx with Location, got ${status}"`. Add regression test coverage for `307`-with-`Location` (success), `200`-empty (failure), and `3xx`-with-invalid-`Location` (failure) — the current mock only produces `302`, so the failing branch is uncovered.
**Branch**: `965-summary-freshly-deployed`
**Status**: Complete

## Summary

`SmeeChannelResolver.provision()` (`packages/orchestrator/src/services/smee-channel-resolver.ts:132-168`) was written in #952 (commit `d0bafbcd`, 2026-07-15) against smee.io's then-behavior of `POST https://smee.io/new` returning `302` + `Location`. smee.io has since silently flipped its `/new` endpoint on two axes:

1. **Method**: channels are now minted on `GET`/`HEAD`. `POST` returns `200 content-length: 0` — a no-op.
2. **Status**: the redirect is now `307`, not `302`.

The provisioner's two-line guard (`method: 'POST'` + `if (response.status !== 302)`) fails on both flips. Every cluster booted from `ghcr.io/generacy-ai/cluster-base:preview` without `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` explicitly set falls back to 10s polling, losing webhook-driven latency guarantees fleet-wide. The unit test (`smee-channel-resolver.test.ts`) hand-builds `Response(status: 302)` for every provisioning case, so no test ever exercised a real live-endpoint response and the failing branch is uncovered.

The fix is three surgical edits inside `provision()`:

- `method: 'POST'` → `method: 'GET'` (FR-001, clarification Q2 → A: GET, not HEAD — empirically verified, universal support, less exposure to intermediary HEAD-handling quirks).
- `response.status !== 302` → `response.status < 300 || response.status >= 400` (FR-002, clarification Q1 → B: broad range hedges against another silent smee.io flip; the existing `SMEE_URL_PATTERN` check on `Location` degrades safely for non-redirect 3xx statuses like 304/305/306).
- `lastError = ` `unexpected status ${response.status}` `` → `lastError = ` `expected 3xx with Location, got ${response.status}` `` (FR-007, clarification Q3 → A: ships in this PR because the same line is being edited — deferring would leave spec/impl drift and drop the exact diagnostic that would surface the next upstream drift from logs alone).

No architectural change. Retry envelope (attempts, backoff, timeout, sleep), persistence path (`readPersistedFile` / `writePersistedFile`), 4-tier precedence, and the `SMEE_URL_PATTERN` regex all stay as-is (FR-004, FR-006). The `redirect: 'manual'` + `Location` header approach is intentionally preserved over `redirect: 'follow'` — it keeps the existing `SMEE_URL_PATTERN` validation on `Location` and preserves the smaller-change footprint.

Test coverage is the load-bearing companion. `make302` in `smee-channel-resolver.test.ts:10-15` is renamed/generalized to `makeRedirect(status, location)` so tests can produce real-shaped `307`-with-`Location` (success), `200`-empty (failure), and `3xx`-with-invalid-`Location` (failure). The `200`-empty test also asserts the FR-007 rejection message wording to satisfy SC-003.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22.
- **Packages touched**: `@generacy-ai/orchestrator` only. No new packages, no new dependencies.
- **Runtime dependencies**: none new. Uses `globalThis.fetch` (already injected via `SmeeChannelResolverOptions.fetch` for tests).
- **Existing constraints observed**:
  - `SmeeChannelResolver.resolve()` must never throw — every failure folds into `return null` (spec FR-006, resolver's original design invariant from #952). The three edits preserve this: the guard change is a pure predicate flip inside the existing `try` / `for` envelope.
  - `SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/` is unchanged. Both `POST`-era and current `GET`-era channel URLs match it (e.g. `https://smee.io/3dCinhK6djyd2yK`).
  - `MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`, `HTTP_TIMEOUT_MS = 5000` — retry envelope unchanged (FR-006).
  - The explicit-override path (`SMEE_CHANNEL_URL` env / `orchestrator.smeeChannelUrl` config) bypasses `provision()` via the `presetUrl` early return at `resolve():73-75` — untouched (FR-004).
- **Deployment envelope**: single package (`@generacy-ai/orchestrator`) in a single PR. No cluster-base or generacy-cloud companion.
- **Changeset**: `.changeset/965-*.md` — `patch` on `@generacy-ai/orchestrator`. This is `workflow:speckit-bugfix` per the CLAUDE.md changeset rules (defect fix, not new capability). No public API surface added or changed.

## Project Structure

Two files change. Nothing new.

```
packages/orchestrator/src/services/
├── smee-channel-resolver.ts                     [MODIFY]
│   - L137: `method: 'POST'` → `method: 'GET'`   (FR-001)
│   - L141: `if (response.status !== 302) {`     (FR-002)
│       → `if (response.status < 300 || response.status >= 400) {`
│   - L142: `lastError = ` `unexpected status ${response.status}` ``   (FR-007)
│       → `lastError = ` `expected 3xx with Location, got ${response.status}` ``
│   - No changes to: retry loop bounds, timeout, `SMEE_URL_PATTERN` check on `Location`,
│     missing-`Location` branch, catch-block, sleep between attempts, warn log at L163-166,
│     or the 4-tier `resolve()` precedence (presetUrl, persisted, provision, persist).
│   - Optional docstring update at file header lines 6-7 to reflect `GET` instead of `POST`
│     (cosmetic, non-load-bearing).
└── __tests__/smee-channel-resolver.test.ts      [MODIFY]
    - Generalize `make302(location)` at L10-15 → `makeRedirect(status, location)` so
      tests can produce arbitrary redirect status codes (or add a sibling helper and
      keep make302 for existing tests — either shape is fine; goal is to unblock the
      three new cases below without duplicating 5 lines of Response-building).
    - Add: `307`-with-valid-`Location` → success                    (FR-005 case 1, SC-002 case 1)
    - Add: `200`-empty-body → failure, retries exhausted, lastError
      matches `expected 3xx with Location, got 200`                 (FR-005 case 2, SC-002 case 2, SC-003)
    - Add: `3xx`-with-invalid-`Location` (e.g. `307` → `https://evil.com/x`)
      → failure via the existing SMEE_URL_PATTERN check              (FR-005 case 3, SC-002 case 3)
    - Existing tests continue to pass unchanged (302 is inside the new 3xx range;
      no test asserts on the request method today — verified via grep — so the
      POST→GET flip is transparent to the existing suite).

.changeset/965-*.md                              [ADD]
    - Bump: `@generacy-ai/orchestrator` patch
    - Body: one-line summary — "Fix SmeeChannelResolver.provision() to match smee.io's
      current GET/307 behavior; provisioning previously failed on POST/302 assumptions
      and every fresh cluster fell back to polling."

specs/965-summary-freshly-deployed/
├── spec.md                                      [read-only]
├── clarifications.md                            [read-only]
├── plan.md                                      [THIS FILE]
├── research.md                                  [ADD]
├── data-model.md                                [ADD]
├── quickstart.md                                [ADD]
└── contracts/
    └── provision-response.md                    [ADD]  Acceptance predicate contract
```

**Files NOT changing:**

- `packages/orchestrator/src/services/server-smee-provisioning.test.ts`, `server-smee-fallback-warning.test.ts`, `server-smee-opt-out-info.test.ts` — server-level integration tests. They exercise the resolver through `createServer()` wiring and are agnostic to the internal `POST`→`GET` and `302`→3xx flips. No update needed unless a fixture explicitly stages a mock response with `status: 302` **and** the test asserts request method — a grep confirms neither is true.
- `packages/orchestrator/src/services/smee-receiver.test.ts` — exercises the receiver, not the resolver. Unrelated.
- Retry policy, backoff, timeout constants — spec §Out of Scope and FR-006 explicitly preserve.
- `SMEE_URL_PATTERN` regex — spec §Assumptions confirms both eras' URLs match.
- Presetted-URL bypass path — spec FR-004 explicitly preserves.
- The `redirect: 'manual'` mode — spec §Out of Scope excludes `redirect: 'follow'`.
- Health check that periodically re-validates the channel — spec §Out of Scope.
- Cluster-side telemetry alerting on smee.io breaking changes — spec §Out of Scope.
- Alternative webhook-forwarder service — spec §Out of Scope.

## Design invariants

1. **Broad 3xx range, not enumerated set.** Per clarification Q1 → B, the guard is `response.status >= 300 && response.status < 400`. Do NOT hard-code `307` or a `[301, 302, 303, 307, 308]` set. Smee.io already flipped once (`302` → `307`, `POST` → `GET`); the broad range is the hedge against the next silent flip. The `SMEE_URL_PATTERN` re-check on `Location` catches the corner cases (`304`/`305`/`306`) that carry no valid smee URL — they fail the pattern check and fall through to the same `Location does not match SMEE_URL_PATTERN` branch that already exists.
2. **GET, not HEAD.** Per clarification Q2 → A, use `GET`. `HEAD`'s only advantage (no response body) saves ~66 bytes, which is negligible against `GET`'s universal support and lower exposure to intermediary/proxy `HEAD`-handling quirks. The response body is discarded — `redirect: 'manual'` means we never read it.
3. **`redirect: 'manual'` is preserved.** The fix keeps the manual-redirect + `Location` header approach over `redirect: 'follow'` (spec §Out of Scope). This preserves the existing `SMEE_URL_PATTERN` validation on `Location` — with `follow`, we'd validate the final resolved URL, which requires trusting the intermediate redirect chain and gains us nothing.
4. **Fail-open resolver semantics unchanged.** Every failure mode still folds into `return null` in `provision()`, and every failure mode in `resolve()` still degrades to `null` → polling. This is the spec FR-006 invariant from #952. The three edits are pure predicate/string changes inside the existing `try` / `for` envelope — no new throw points, no new async surface.
5. **Test coverage MUST exercise real-shaped responses.** SC-002 requires three new tests hitting `307`-with-`Location`, `200`-empty, and `3xx`-with-invalid-`Location`. The `302`-only mock in the current test file is the exact reason this bug shipped uncaught in #952 — adding tests that construct responses matching the shapes we see over the wire (not the shape we imagined we'd see) is load-bearing for closing the FR-005 gap and preventing the same class of regression on the next smee.io flip.
6. **Diagnostic wording is the tripwire for the next upstream drift.** FR-007's `expected 3xx with Location, got ${status}` is the string that would surface the next silent smee.io behavior change from logs alone. This is why Q3 → A included it in this PR — spec/impl drift and diagnostic quality both fixed for the same edit.

## Constitution check

No `.specify/memory/constitution.md` in this repo. Cross-referenced against the codebase conventions inline in `CLAUDE.md`:

- ✅ Changeset required on any non-test change under `packages/*/src/` — planned (`.changeset/965-*.md`).
- ✅ Bump level: defect fix → `patch` on the single package touched (`@generacy-ai/orchestrator`). Matches CLAUDE.md's `workflow:speckit-bugfix` rule.
- ✅ No new comments beyond what the fix inherently changes. The docstring at the top of `smee-channel-resolver.ts` mentions `POST` — updating the one word "POST" to "GET" is a factual correction to keep the file self-consistent, not new commentary.
- ✅ No feature flags, no backwards-compat shims, no legacy handling. The old `302`-only guard is deleted, not left in a deprecated branch — `302` is inside the new `>= 300 && < 400` range so any hypothetical smee.io rollback also works.
- ✅ Fail-closed-only when the state is dangerous; fail-open (return `null` → polling) when the state is merely uncertain. Preserved verbatim — this is the spec FR-006 invariant from #952 and this PR does not change it.
- ✅ No abstractions beyond the fix. No helper extraction, no config surface, no strategy pattern for "future webhook forwarders." Spec §Out of Scope explicitly excludes alternative-forwarder work.

## Phasing

Single PR. All three edits (`method`, `status guard`, `error string`) live on adjacent lines (L137, L141, L142). The three new tests share `makeRedirect(status, location)`. Splitting into multiple PRs would either leave a partial fix (method-only or status-only doesn't provision successfully) or force test-only PRs against production behavior we've already changed. FR-007's wording change is bundled here per Q3 → A — same line edit, zero incremental cost.

## Next step

Run `/speckit:tasks` to break the plan into an ordered task list with dependency markers.
