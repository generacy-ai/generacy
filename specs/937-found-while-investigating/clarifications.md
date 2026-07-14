# Clarifications

## Batch 1 — 2026-07-14

### Q1: GH_TOKEN validity criterion
**Context**: FR-001 says `needsRetry = false` when `GH_TOKEN` is "missing/empty", but FR-004 mentions "`GH_TOKEN=<40+ chars>`". The exact predicate determines whether a partially-sealed / placeholder / stub token slips through the gate.
**Question**: How strictly should `checkPostActivationState()` validate `GH_TOKEN` before treating it as "present"?
**Options**:
- A: **Presence-only** — key exists and value is a non-empty string after trim (any length ≥ 1).
- B: **Non-trivial length** — key exists and trimmed value length ≥ 20 (rejects obvious stubs but doesn't lock in a specific token format).
- C: **GitHub-token shape** — key exists and trimmed value length ≥ 40 (matches classic PAT / installation-token length; aligns with FR-004's `<40+ chars>` note).

**Answer**: A — Presence-only (key exists, value non-empty after trim). Matches the codebase's own canonical predicate: `writeWizardEnvFile` defines a usable token as `GH_TOKEN` present with `value.length > 0` (`wizard-env-writer.ts`). A length gate couples to token shape (GitHub formats vary: `ghp_`/`ghs_`/`github_pat_…`); FR-004's "40+ chars" is descriptive, not a validation rule. The writer never emits a stub — it writes a real unsealed token or omits the key — so there is no placeholder to reject.

### Q2: FR-006 defense-in-depth inclusion
**Context**: FR-006 is marked P2/optional; the issue text says "either alone would have prevented it" but recommends doing at least FR-001. The plan/tasks phases need a definitive scope decision because FR-006 touches a different package (`control-plane`) and adds a separate regression test (RT-004).
**Question**: Should this fix ship FR-006 (gate `bootstrap-complete` sentinel write on `hasGitHubToken` in the control-plane) alongside FR-001, or defer it?
**Options**:
- A: **Ship both** — FR-001 in the orchestrator plus FR-006 in the control-plane, in a single PR. Belt-and-braces; also lands RT-004.
- B: **Ship FR-001 only** — narrow, minimal-diff orchestrator fix; open a follow-up issue for FR-006.
- C: **Ship FR-006 only** — treat the control-plane gate as the canonical fix and skip the orchestrator predicate change.

**Answer**: A — Ship both, single PR. Orchestrator and control-plane are packages in the same repo, so this stays self-contained. FR-001 removes the known premature caller; FR-006 makes the sentinel write itself safe against any future premature `bootstrap-complete` replay, closing the class rather than just today's trigger. Implementation note: `bootstrap-complete` is the terminal step, so FR-006 must still fire the sentinel whenever a token IS present and only defer (emit the awaiting-credentials event) when it is genuinely absent — this regresses nothing, since a `REPO_URL` cluster with no token already fails the post-activation guard today.

### Q3: Deferred-state observability
**Context**: SC-002 is a *negative* assertion ("no premature replay log line"). For debugging and for the SC-005 exactly-once assertion, an operator needs to be able to see *why* the retry deferred on a fresh cluster. The current retry service logs `Post-activation incomplete on restart — triggering retry` on the fire path; the deferred path has no positive log today.
**Question**: When `checkPostActivationState()` returns `needsRetry = false` because credentials are missing (as opposed to `postActivationComplete === true`), what observability MUST the fix emit?
**Options**:
- A: **Log line only** — one `logger.info` (e.g., `Post-activation retry deferred — GH_TOKEN not yet sealed in wizard-credentials.env`); no relay event.
- B: **Log line + relay event** — the info log plus a `cluster.bootstrap` relay event (e.g., `{ status: 'deferred', reason: 'awaiting-credentials' }`) mirroring the existing `awaiting-credentials` shape used by `prepare-workspace` in `lifecycle.ts:151-154`.
- C: **No new observability** — silent defer; the absence of the "triggering retry" log is sufficient signal.

**Answer**: B — Log line + relay event. Mirror the existing `cluster.bootstrap` / `awaiting-credentials` event that `prepare-workspace` already emits on its defer path (`lifecycle.ts:151-154`), reusing the exact reason string `github-token-not-sealed` so both defer paths look identical to the cloud. The retry service already emits `retrying`/`failed` events, so a silent defer would leave the cloud UI blind on exactly the stuck-fresh-cluster case being fixed.

### Q4: wizard-credentials.env path resolution
**Context**: The existing `PostActivationRetryService` accepts `completionFlagPath` and `keyFilePath` as constructor options for test-seam and env-override reasons (`packages/orchestrator/src/services/post-activation-retry.ts:13-45`). Adding a new file-read for `wizard-credentials.env` can follow the same pattern or hard-code the constant. The control-plane already respects a `WIZARD_CREDS_PATH` env var override (`lifecycle.ts:171`).
**Question**: How should the wizard-credentials path be sourced in the new check?
**Options**:
- A: **Match sibling pattern** — new `wizardCredsPath` constructor option, defaulting to `/var/lib/generacy/wizard-credentials.env`. No env-var read inside the service.
- B: **Match control-plane pattern** — read `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'` at check time, no constructor option.
- C: **Both** — constructor option that itself defaults to `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'` (test seam + prod env override).

**Answer**: C — Constructor `wizardCredsPath` option defaulting to `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'`. Honoring `WIZARD_CREDS_PATH` is a correctness requirement, not style: the control-plane writes the file at that overridable path (`lifecycle.ts:171`); if the orchestrator hard-codes the default, a relocated creds file silently defeats the gate. The constructor option preserves the existing `completionFlagPath` / `keyFilePath` test-seam pattern.

### Q5: Env-file parsing scope
**Context**: The wizard-env-writer emits plain `KEY=VALUE` lines with no quoting, no comments, no escapes (`wizard-env-writer.ts`). The new check needs to extract `GH_TOKEN` — a naive line scan works today but coupling to writer internals is a hazard if the writer format ever grows. FR-004 asserts the format contract, but doesn't say whether the reader should be tolerant or strict.
**Question**: How should the check parse `GH_TOKEN` out of `wizard-credentials.env`?
**Options**:
- A: **Minimal regex** — match `/^GH_TOKEN=(.+)$/m` on the raw file contents; treat any capture group after trim as the token value. Assumes writer contract.
- B: **Line-by-line KEY=VALUE split** — parse each line at the first `=`, build a plain object, read `GH_TOKEN`. Slightly more robust to trailing whitespace / blank lines.
- C: **Full dotenv semantics** — use a real env-file parser (quoted values, `#` comments, escapes). Overkill today but future-proofs against writer changes.

**Answer**: B — Line-by-line `KEY=VALUE` split (split on the first `=`, trim the value). The writer emits plain `KEY=VALUE` lines with no quoting/comments/escapes (`formatEnvFile`), so full dotenv semantics are overkill; line-split is more robust than a bare regex to the trailing newline / blank lines and composes with the Q1 presence check. Splitting on the first `=` preserves an opaque value.
