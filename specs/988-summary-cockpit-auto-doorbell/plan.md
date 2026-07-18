# Implementation Plan: `/cockpit:auto` doorbell webhook-config channel discovery

**Feature**: Discover the smee channel from the registered repo webhook so `/cockpit:auto` reaches `source=smee` end-to-end without env or shared-filesystem workarounds.
**Branch**: `988-summary-cockpit-auto-doorbell`
**Status**: Complete

## Summary

`discoverChannelUrl` currently only reads env + workspace/cluster filesystem paths. Operator sessions running `/cockpit:auto` outside the cluster containers do not share the cluster FS, so discovery always returns `null` → poll-fallback unless the operator manually exports `COCKPIT_DOORBELL_SMEE_URL`. The interim workaround from #980 (`/workspaces/.generacy/cockpit/smee-channel`) only helps when the operator shares `/workspaces` with the cluster — the common case in the current deployment topology is that they do not.

This change adds an authoritative discovery stage that reads the smee URL directly from the repo webhook config the orchestrator already registered (`gh api repos/{owner}/{repo}/hooks`). The stage:

- Runs **after** `env` and **before** the FS stages (clarification Q1=A): env stays as the explicit operator override; webhook-config beats a possibly-stale FS mirror.
- Accepts a **pre-parsed** `targets: Array<{owner, repo}>` (Q3=C): the caller (`doorbell.ts`) already resolves the epic ref set via `resolveEpic`, so `channel-discovery.ts` stays ref-parsing-free.
- Iterates targets **primary-first, first-match-wins** with early-stop (Q2=B): bounded at ≤N calls, typically 1.
- **Tie-breaks** repos with multiple smee hooks by `active: true`, then `updated_at` desc (Q4=D): defends against stale-registration-alongside-fresh-registration.
- Applies a **5s bounded timeout** per `gh api …/hooks` call (Q5=B): a network hang would stall `armed\n` + `source=…` that agency#437 parses.
- **Degrades gracefully** on scope-lack (403), non-zero exit, zero-match, and timeout — falls through to the existing FS stages.

Zero per-event cost: one `gh api` call per repo per doorbell startup, ≤ `targets.length` total (typically 1).

The FR-006 stderr line becomes `cockpit doorbell: source=smee reason=startup-smee-selected` on success — the label the agency skill already parses. The specific `webhook-config` stage tag is an internal implementation detail exposed in the `ChannelSource` union for tests.

## Technical Context

- **Language / Version**: TypeScript (ESM, Node >=22), matching the existing `packages/generacy` toolchain.
- **Primary dependencies (existing)**:
  - `@generacy-ai/cockpit` — `resolveEpic` (already imported by `smee-source.ts`), `GhWrapper`, `CommandRunner`, `nodeChildProcessRunner`.
  - Native `node:child_process` — accessed indirectly via `CommandRunner`; the `webhook-config` stage does **not** import `child_process` directly (Q3=C keeps discovery dep-light).
  - `zod` — schema validation of the `/hooks` JSON payload.
  - `AbortController` — bounded per-call timeout (Q5=B).
- **New dependencies**: none.
- **Packages touched**:
  - `packages/generacy/` — `channel-discovery.ts` gains the `webhook-config` stage; `doorbell.ts` resolves `targets` from the epic ref set before calling discovery; new `webhook-target-resolver.ts` helper.
  - No changes to `@generacy-ai/cockpit`, `@generacy-ai/orchestrator`, or the agency skill.
- **Test runner**: Vitest, matching existing convention in `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/`.
- **Storage**: None. Discovery is pure I/O + one network call, no persistence.
- **Performance goals**:
  - SC-002: ≤ `targets.length` `gh api` calls per doorbell startup (typically 1), zero per-event.
  - SC-005: `webhook-config` stage never blocks doorbell startup > 5s (bounded per-repo timeout).
- **Constraints**:
  - **No change** to the `armed\n` timing or shape (agency#431/#437 depend on it, preserved from #978/#980).
  - **No change** to stdout event line shape (`lineForEvent`).
  - **No change** to the FR-006 stderr `source=…` protocol (only the specific reason strings the selector emits).
  - **No new `gh` scope**. Uses the same token the operator already has; `admin:repo_hook` read scope is the same scope the orchestrator needs to register the hook.
  - **`webhook-config` is best-effort**: any failure (403/timeout/malformed/zero-match/non-zero exit) falls through silently to FS stages; the doorbell never hard-fails on this path.

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

## Project Structure

### Documentation (this feature)

```
specs/988-summary-cockpit-auto-doorbell/
├── plan.md                            # this file
├── research.md                        # decisions + alternatives
├── data-model.md                      # types and validation rules
├── quickstart.md                      # verify locally
├── contracts/
│   ├── channel-discovery.md           # extended lookup chain (FR-001, FR-004, FR-006)
│   └── webhook-target-resolver.md     # resolveEpic → targets contract (FR-003, FR-008)
├── spec.md                            # (existing)
└── clarifications.md                  # (existing)
```

### Source code changes

```
packages/generacy/src/cli/commands/cockpit/
├── doorbell.ts                        # resolve `targets` via resolveEpic before discover(); wire runner/gh into discovery input
└── doorbell/
    ├── channel-discovery.ts           # new webhook-config stage; input gains `targets`, `runner`, optional timeoutMs
    ├── webhook-target-resolver.ts     # NEW: resolveEpic-backed `{form.ref} → Array<{owner,repo}>` (primary-first, dedup)
    └── __tests__/
        ├── channel-discovery.test.ts       # + webhook-config stage cases (7 new tests, see contracts/)
        └── webhook-target-resolver.test.ts # NEW: primary-first ordering + dedup + resolveEpic-failure fallback
```

## Phase 0: Research

See `research.md`. Six questions:

1. **Where does the `gh api …/hooks` call live?**
   → Inline in `channel-discovery.ts` via the injected `runner: CommandRunner` (existing `@generacy-ai/cockpit` type). No new module; keeps discovery a single-file contract. Rejected: adding a method to `GhWrapper` (bloats the wrapper surface for one caller).

2. **Where does the caller derive `targets`?**
   → New helper `webhook-target-resolver.ts` that calls `resolveEpic` and produces `Array<{owner, repo}>` primary-first (epic repo first, then unique repos from `parsed.allRefs` in `repos` order). `doorbell.ts` calls it inside the same `discoverChannel` branch (guarded by `deps.gh != null`). On `resolveEpic` failure, returns `[]` — discovery falls through to FS stages exactly as today.

3. **What is the timeout mechanism?**
   → `AbortController` passed via `CommandRunner.CommandRunnerOptions` is **not** currently a thing; the runner's own `timeoutMs` field works. We pass `timeoutMs: 5_000` and treat any non-zero exit (including the runner's `exitCode: 124` timeout signal) as fall-through.

4. **Which `updated_at` field wins the tie-break?**
   → GitHub's `/repos/{owner}/{repo}/hooks` response includes both `created_at` and `updated_at`; `updated_at` reflects the most recent PATCH (e.g., URL rotation via `ensureWebhooks`'s `update-url` path). We sort by `updated_at` desc using `Date.parse()`; hooks with unparseable `updated_at` sort last.

5. **How do we surface the stage in the `SourceSelector` line?**
   → `ChannelSource` union gains `'webhook-config'`. `SourceSelector` maps every non-poll source to the string label `smee` (line-format function at `source-selector.ts:35`) so the operator-visible `reason=startup-smee-selected` is unchanged. Tests assert the internal `ChannelDiscoveryResult.source === 'webhook-config'` where relevant; the stderr line stays `source=smee reason=…`.

6. **Do we need to gate the stage on `deps.gh != null`?**
   → Yes. Today's discovery is dep-free (env + FS); today's smee-mode is already gated on `deps.gh != null` (see `doorbell.ts:382`). Threading `runner` through the same guard preserves the invariant "no smee-mode = no unnecessary work" and keeps the CLI-only ergonomics of discovery: unit tests without a runner still exercise the FS stages.

## Phase 1: Contracts

See `contracts/channel-discovery.md` and `contracts/webhook-target-resolver.md`.

Key surface changes (backwards-compatible):

- `ChannelDiscoveryInput` gains three optional fields:
  - `targets?: Array<{ owner: string; repo: string }>` — pre-parsed repo list, primary-first.
  - `runner?: CommandRunner` — command runner used by the `webhook-config` stage; when absent, the stage is skipped (falls through to FS).
  - `webhookConfigTimeoutMs?: number` — default 5000, exposed for tests.
- `ChannelSource` union gains `'webhook-config'`.
- `discoverChannelUrl` semantics change only when both `targets.length > 0` and `runner != null`; today's env-only / FS-only callers see identical behavior.

## Phase 2: Data model

See `data-model.md`. Highlights:

- `SmeeHook` (Zod-validated subset of GitHub's `/hooks` response): `{ id: number; active: boolean; config: { url: string }; updated_at: string }`.
- `PickSmeeHookInput` / `PickSmeeHookResult` — pure function inputs/outputs for the tie-break (unit-testable in isolation).
- No new persisted schema; no cache; no state.

## Phase 3: Implementation notes

1. **`channel-discovery.ts` extension** (the file):
   - Add `webhookConfigTimeoutMs` constant (default `5_000`).
   - Add pure function `pickSmeeHook(hooks: SmeeHook[]): SmeeHook | null` — filter `active === true`, filter `SMEE_URL_PATTERN.test(config.url)`, sort by `Date.parse(updated_at)` desc, return `[0] ?? null`. Unparseable `updated_at` treated as `-Infinity` (sorts last).
   - Add async function `runWebhookConfigStage(input, target): Promise<string | null>` — invokes `runner('gh', ['api', `/repos/${owner}/${repo}/hooks`], { timeoutMs })`; on non-zero exit or JSON parse failure, returns `null` and logs one warn line (with the target repo); on zero-match after tie-break, returns `null` silently; on match, returns the URL.
   - `discoverChannelUrl` reorders to: env → webhook-config-loop-over-targets → walk-up → workspace-absolute → cluster-file (spec FR-004). Between env and walk-up, iterate `targets ?? []` and call `runWebhookConfigStage`; return `{ url, source: 'webhook-config' }` on the first match.
   - Zero-target or missing-runner path is a no-op (falls through to walk-up).

2. **`webhook-target-resolver.ts`** (new):
   - `resolveWebhookTargets({ epicRef, gh, logger })` calls `resolveEpic`, produces `[epic-repo, ...allRefs-repos-dedup-in-order]`. Splits each `"owner/repo"` string on `/` (already the shape used elsewhere).
   - On any error (LoudResolverError, network), returns `[]` and logs one warn line — discovery still runs, just skips the webhook-config stage.

3. **`doorbell.ts` wiring**:
   - Inside the existing `discoverChannel` branch (guarded by `deps.gh != null || deps.discoverChannel != null`), call `resolveWebhookTargets` **before** `discover(...)` when `deps.gh != null`.
   - Pass `targets` and `deps.runner ?? nodeChildProcessRunner` (import is already available) into the `discoverChannelUrl` input.
   - The `discoverChannel` test seam stays as-is; new tests exercise the real `discoverChannelUrl` with an in-memory runner.

4. **Test seams**:
   - `channel-discovery.test.ts` gains 7 cases (see `contracts/channel-discovery.md`): webhook-config hit / stale-hook tie-break / multi-repo primary-first / multi-repo fallback-to-second / 403 fall-through / timeout fall-through / no-runner fall-through.
   - `webhook-target-resolver.test.ts` gains 4 cases: single-repo epic / multi-repo epic dedup / epic-repo-first ordering / `resolveEpic`-failure returns `[]`.
   - `doorbell-source-branch.test.ts` (existing) gets one additional case that stubs a `gh api …/hooks` runner and asserts `source=smee` end-to-end without env or FS setup — regression coverage for SC-001.

5. **Changeset**:
   - Add `.changeset/988-doorbell-webhook-config-discovery.md` at PR time.
   - Bump level: `patch` for `@generacy-ai/generacy` (defect-fix — completing the doorbell's cross-session discovery contract). No public API additions to the package's `index.ts`.

## Phase 4: Non-goals / out of scope

Copied from spec §"Out of Scope" for reader convenience — no new decisions here:

- Refactoring the existing FS stages (`walk-up`, `workspace-absolute`, `cluster-file`).
- Mid-session cache invalidation for the webhook-config result (a channel rotation still requires doorbell restart — matches today's FS-mirror behavior).
- New `gh` scope or credential-helper integration.
- Aggregate multi-repo channel-divergence detection (Q2=C rejected — orchestrator guarantees a single channel per cluster).
- Non-smee webhook receivers.

## Suggested next step

Run `/speckit:tasks` to generate the task list from this plan.
