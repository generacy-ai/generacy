# Research

## R1. Why the premature replay is deterministic on fresh wizard clusters

**Question**: Why does `runPostActivationBranch()` always fire `bootstrap-complete` before wizard credentials seal?

**Investigation**:
- `PostActivationRetryService.checkPostActivationState()` (`packages/orchestrator/src/services/post-activation-retry.ts:47`) computes `needsRetry = activated && !postActivationComplete` — pure boolean over two files. On a fresh cluster the api-key file has just been written by `activate()` and no post-activation has ever run, so both operands are true.
- `runPostActivationBranch` (`packages/orchestrator/src/services/post-activation-dispatch.ts:39`) takes the `needsRetry` branch first and fires `triggerPostActivationRetry()` fire-and-forget.
- `triggerPostActivationRetry` waits up to 15 s for the control-plane socket then POSTs `/lifecycle/bootstrap-complete`. Control-plane writes the sentinel unconditionally.

**Timing evidence** (from `snappoll-3` logs, spec §Observed):
- `01:15:01` activation completes → replay fires within the same second.
- `01:15:03` post-activation aborts (no `GH_TOKEN`).
- `01:17:23` wizard finishes and creds seal — 2 min 22 s later.

**Conclusion**: The race is deterministic on the interactive wizard path — activation completes seconds after cluster boot, but the human takes minutes to enter credentials. `needsRetry` is *trivially* true on first activation because the "not complete" condition is definitional for a cluster that has never run post-activation. The retry service was designed for restart-after-creds-delivered recovery, so this first-boot firing was never intended.

**Decision**: Gate `needsRetry` on `GH_TOKEN` presence (FR-001). Alternatives considered:
- **A**: Add a "has-boot-completed-once" flag file — rejected: adds state to track; still races the first boot.
- **B**: Move dispatch outside the activation path — rejected: also fires boot-resume (`triggerBootResume`) which is orthogonal; refactor cost > payoff.
- **C**: Poll for credentials — rejected: violates the service's one-shot-at-activation contract (spec Assumptions §2); introduces a background timer we'd have to reason about across container restarts.

## R2. Why is `wizard-credentials.env` the right signal (vs. querying credhelper directly)?

**Question**: Should the gate check the file, or query the credhelper daemon for a `GH_TOKEN`-shaped credential?

**Investigation**:
- The file is what `entrypoint-post-activation.sh` itself sources — its guard is `if [[ -z "${GH_TOKEN:-}" ]]`. Gating on the same signal makes the orchestrator and the watcher agree by construction.
- The credhelper daemon may hold a github-app credential that hasn't been unsealed to env yet (unsealed only when `writeWizardEnvFile()` runs); the file is the *rendered* signal.
- Cross-package dependency: importing the credhelper HTTP client into the orchestrator's activation path is a wider surface than a file existence + `readFileSync` check.

**Decision**: Read the file (FR-004). Aligns with what `post-activation-watcher.sh` reads and what `writeWizardEnvFile`'s own `hasGitHubToken` predicate covers.

## R3. Env-file parsing scope (dotenv vs. line-split vs. regex)

Clarified in Q5 → **B** (line-split, first-`=` split, trim value). See `plan.md` §D3.

Additional detail: `formatEnvFile()` in `wizard-env-writer.ts:83` emits `entries.map((e) => \`${e.key}=${e.value}\`).join('\n') + '\n'`. No quoting, no escaping. A minimal line parser therefore has zero risk of mismatch. Full dotenv semantics would add a dependency and false-positive-match on `#` inside opaque token values (theoretically possible for `github_pat_…` values, though currently never observed).

## R4. Sync vs. async file read in `checkPostActivationState()`

**Question**: Should the new file read be async to match `writeWizardEnvFile`'s async style?

**Investigation**:
- `checkPostActivationState()` returns `PostActivationState` synchronously today. Callers in `post-activation-dispatch.ts` and `server.ts` treat it as sync.
- Making it async would ripple through both call sites and change the return type to `Promise<PostActivationState>`.
- File is <1 KB, read once at boot, on a fast local FS.

**Decision**: `readFileSync`. Documented in `plan.md` §D3. Trade-off is minimal (a few ms of blocking I/O once per boot); rippling async through the call sites adds churn with no user-visible benefit.

## R5. Relay event `status` differentiation

**Question**: Should the new defer event use `awaiting-credentials` (identical to `prepare-workspace`) or a distinct `deferred`?

Clarified in Q3 → **B**: log line + relay event with reason `github-token-not-sealed`.

FR-002 note ("do NOT reuse `awaiting-credentials` literally") points at differentiating by status. Rationale expanded here:

- `prepare-workspace` emits `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }`.
- The new retry-defer event uses `{ status: 'deferred', reason: 'github-token-not-sealed' }`.
- Reason is IDENTICAL — the cloud dashboard already knows what "github-token-not-sealed" means; only the `status` differs so operators can distinguish "wizard called `prepare-workspace` early" from "orchestrator retry hit the same guard".
- Both are on `cluster.bootstrap`. No cloud-side change needed (Out of Scope §4).

## R6. Contrast with the existing `prepare-workspace` defer path

**Investigation of `lifecycle.ts:113-165`**:
- `prepare-workspace` calls `writeWizardEnvFile()` and receives `hasGitHubToken`.
- On `hasGitHubToken === true`: writes the sentinel.
- On `hasGitHubToken === false`: emits `cluster.bootstrap` `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }` and returns `sentinel: null`.
- Comment at lines 121-126 documents the same race we're closing on `bootstrap-complete`: "the sentinel is only written once the GitHub token is actually sealed — otherwise the one-shot post-activation watcher fires the deferred clone before GH_TOKEN exists, clones nothing, and never re-runs when the token lands. When the token isn't ready yet we skip the sentinel; bootstrap-complete (end of wizard, full credentials) fires it."

That comment is now outdated — its assumption that "bootstrap-complete fires only at end of wizard, full credentials" holds for the *wizard-driven* call but is violated by the orchestrator's retry replay. FR-006 fixes the invariant at the sentinel-write site itself, not just the caller.

## R7. Why FR-001 alone is insufficient (motivation for shipping FR-006 together)

Q2 → A ("ship both"). Concrete failure modes FR-006 closes:

1. **Container restart with creds unsealed** — if the wizard was interrupted after api-key persist but before credentials, on next boot the retry defers (FR-001 catches it). But if a *user* or the cloud manually POSTs `/lifecycle/bootstrap-complete` (e.g. via a future retry UI) with no creds sealed, FR-001 does nothing and the sentinel writes. FR-006 catches that too.
2. **Any future retry entry point** — engineers adding a new caller to `POST /lifecycle/bootstrap-complete` (or wiring it into a scheduled task) shouldn't have to re-discover the token gate.
3. **Defense-in-depth** — same reasoning as `prepare-workspace` already carries. The sentinel write itself is the class of failure; FR-006 makes it safe.

## R8. Existing test patterns in `post-activation-retry.test.ts`

- Uses `mkdtempSync` + `writeFileSync` for `keyFilePath` / `completionFlagPath` — same seam applies naturally to a new `wizardCredsPath` option.
- Existing tests exercise `activated && !complete` = `needsRetry === true` at line 85-102. RT-002 will extend that shape with a `writeFileSync(wizardCredsPath, 'GH_TOKEN=ghs_abc\n')` variant. RT-001 mirrors it with a *missing file* case.
- `sendRelayEvent` is already stubbed as `vi.fn()` and asserted-against — extends cleanly to the defer event.

## R9. Existing test patterns in `lifecycle.test.ts` (control-plane)

- `writeWizardEnvFile` is already mocked via `vi.mock` returning `{ written, failed, hasGitHubToken }` shape.
- `prepare-workspace` defer tests (line 472-482) assert `sentinel: null` in the response — RT-004 mirrors this exact assertion shape for `bootstrap-complete`.
- Existing `bootstrap-complete` happy-path tests (line 229+) set `hasGitHubToken: false` today (line 240) but still assert the sentinel is written — those tests need to be updated to set `hasGitHubToken: true` under the new gate, or to switch their assertion to the defer branch. Existing test scope will need adjustment (documented in tasks).

## R10. `runPostActivationBranch` regression coverage (RT-003)

`runPostActivationBranch` in `post-activation-dispatch.ts` returns `'retry' | 'resume' | 'noop'`. RT-003 asserts the *fresh cluster, no creds* case returns `'noop'` — this is a natural consequence of `checkPostActivationState()` now returning `needsRetry: false` AND `postActivationComplete: false`, which falls through the two `if` guards to the terminal `return 'noop'`. The test injects a `retryServiceFactory` that stubs `checkPostActivationState()` to return `{ activated: true, postActivationComplete: false, needsRetry: false }` and asserts `triggerPostActivationRetry` is NOT called and the return value is `'noop'`.

---

## Key References

- `packages/orchestrator/src/services/post-activation-retry.ts:47` — current `checkPostActivationState()` implementation
- `packages/orchestrator/src/services/post-activation-dispatch.ts:37` — `runPostActivationBranch` dispatcher
- `packages/orchestrator/src/server.ts:1022` — call site
- `packages/control-plane/src/routes/lifecycle.ts:113` — `prepare-workspace` handler (template for FR-006)
- `packages/control-plane/src/routes/lifecycle.ts:168` — `bootstrap-complete` handler (target of FR-006)
- `packages/control-plane/src/services/wizard-env-writer.ts:83` — `formatEnvFile()` (contract for FR-004 parser)
- Regressions: `ff9da3a8` (#838) reachability, `967718ef` (#739/#741) prior sentinel-gating fix
