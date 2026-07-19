# Research: `/cockpit:auto` doorbell webhook-config discovery

Six research questions, all answered by the clarifications batch and by reading the current call sites.

## R1: Where does the `gh api …/hooks` call live?

**Decision**: Inline in `channel-discovery.ts` via the injected `runner: CommandRunner` (existing `@generacy-ai/cockpit` type).

**Rationale**:

- `channel-discovery.ts` already accepts `logger`, `fs`, `env` as pinpoint DI — adding `runner` is consistent with that shape.
- Discovery stays a single-file contract; the four existing stages already deliver value from one file, and the new stage is symmetric (it's still "read a URL from a source, validate against `SMEE_URL_PATTERN`, return").
- Zero new module boundaries → less test scaffolding, less import wiring, no new package export.

**Alternatives considered**:

- **Add `listRepoHooks(owner, repo)` to `GhWrapper`.** Rejected: bloats the wrapper for one caller (the doorbell). The wrapper's existing surface is scoped to issue/PR ops the cockpit MCP and watch flows already exercise; hooks are only used here.
- **New `hook-discovery.ts` module owned by discovery.** Rejected: prematurely modular for a ~40-line function with three failure modes (403, timeout, zero-match). If a second consumer materializes later, extraction is trivial.

**Reference**: `packages/orchestrator/src/services/webhook-setup-service.ts:713-728` already reads `/repos/{owner}/{repo}/hooks` via `executeCommand('gh', [...])` — same pattern, different runner (`executeCommand` is orchestrator-side; `CommandRunner` is cockpit-side but functionally equivalent).

## R2: Where does the caller derive `targets`?

**Decision**: New helper `webhook-target-resolver.ts` that calls `resolveEpic` and produces `Array<{owner, repo}>` primary-first (epic repo first, then unique repos from `parsed.allRefs` in `resolved.repos` order).

**Rationale**:

- `resolveEpic` already runs inside `SmeeDoorbellSource.start()` at `smee-source.ts:184`, but its output is not available at `discoverChannel` time (discovery runs *before* smee-source start). Adding a second, cheap `resolveEpic` call at discovery time is fine — the epic body is small, one `gh api` roundtrip, and it's already the shape we need.
- `resolveEpic` is fail-loud (throws on `NO_REFS`, `INVALID_EPIC_REF`, `GH_FETCH_FAILED`). We catch inside the helper and return `[]` on failure so discovery falls through cleanly — matching the "graceful degradation" contract in FR-006.
- Primary-first ordering enforced by putting `resolved.epic.repo` at index 0 explicitly, then appending `resolved.repos.filter(r => r !== resolved.epic.repo)`.
- Splitting `"owner/repo"` on `/` is the shape already used in `smee-source.ts:60-66` (`ref.repo` is `"owner/repo"`) and in `webhook-setup-service.ts`.

**Alternatives considered**:

- **Have discovery own `resolveEpic`.** Rejected: introduces a `@generacy-ai/cockpit` dependency into `channel-discovery.ts`, which is currently dep-light (no cockpit imports). Q3=C's whole point was to keep discovery ref-parsing-free.
- **Reuse the `resolveEpic` result from `SmeeDoorbellSource`.** Rejected: `SmeeDoorbellSource` is instantiated *after* discovery; making discovery depend on smee-source is a circular dep and shifts startup ordering.
- **Parse `form.ref` inline in `doorbell.ts` (skip `resolveEpic`).** Rejected: `form.ref` is one issue ref, not the whole ref set. Multi-repo epics (Q2=B) require the full set; single-repo epics fall out for free.

## R3: What is the timeout mechanism?

**Decision**: Use `CommandRunner.CommandRunnerOptions.timeoutMs` (existing field, defaults to 30_000 in `nodeChildProcessRunner`). Pass `timeoutMs: 5_000`; treat runner's `exitCode: 124` (timeout signal) as fall-through.

**Rationale**:

- `nodeChildProcessRunner` at `packages/cockpit/src/gh/command-runner.ts:76-109` already implements timeout semantics: `execFile`'s `timeout` option + a manual SIGTERM path in `runWithStdin`. On timeout, `exitCode` is set to `124` (matches POSIX convention).
- Passing `timeoutMs: 5_000` bounds the stage without adding new plumbing.
- Q5=B ("bounded timeout with fall-through") maps directly: the stage sees `exitCode !== 0`, emits one warn line with the target repo, returns `null`, discovery advances to the next target or the next stage.

**Alternatives considered**:

- **`AbortController` around a `fetch` to GitHub's REST API directly.** Rejected: bypasses the operator's `gh auth` state, requires manual token wiring, adds an HTTP client where we currently have none in the CLI. `gh api` is already authenticated and available.
- **No timeout.** Rejected explicitly by Q5=B — a hang would stall `armed\n` + `source=…`.

## R4: Which `updated_at` field wins the tie-break?

**Decision**: Sort by `updated_at` desc using `Date.parse()`; hooks with unparseable `updated_at` sort last (treated as `-Infinity`).

**Rationale**:

- GitHub's `/hooks` payload has both `created_at` and `updated_at`. `updated_at` reflects the most recent PATCH — including URL rotations via `ensureWebhooks`'s `update-url` branch (`webhook-setup-service.ts:466`). That's exactly the case Q4=D defends against (stale + fresh side by side after re-registration).
- `Date.parse()` on ISO-8601 (GitHub's format) is deterministic and dep-free. Unparseable → `NaN`; guarding with `Number.isNaN` and mapping to `-Infinity` makes malformed entries sort last without throwing.
- Assumption from spec: "GitHub's REST API contract for these fields is stable." No need for schema versioning.

**Alternatives considered**:

- **`created_at` desc.** Rejected: after `ensureWebhooks` PATCHes an existing hook's URL, `created_at` still points at the original creation moment — the stale-registration scenario would still lose.
- **Highest `id`.** Rejected: `id` is monotonic per-repo but not per-account; edge cases where a stale hook has a higher `id` than a fresh one (unlikely, but possible after a delete-then-recreate) would misfire.

## R5: How do we surface the stage in the `SourceSelector` line?

**Decision**: `ChannelSource` union gains `'webhook-config'`; `SourceSelector`'s `formatLine` function (`source-selector.ts:35`) already maps every non-poll source to the string label `smee`, so the operator-visible stderr line stays `source=smee reason=startup-smee-selected`.

**Rationale**:

- Preserves the FR-006 contract from #978 (agency#437 parses `source=smee` and `source=poll-fallback` only; internal source tags are invisible to the skill).
- `ChannelDiscoveryResult.source` is already exposed for tests — adding `'webhook-config'` lets tests assert the specific stage that resolved without changing the wire format.
- No change to `SourceReason` union: the existing `startup-smee-selected` reason covers "discovery succeeded via any stage".

**Alternatives considered**:

- **Emit a new `source=webhook-config` stderr line.** Rejected: agency#437 would treat it as an unknown label and fall through to heartbeat; FR-010 in the spec explicitly asks for `source=smee` on this path.
- **Emit a distinct reason (`startup-smee-webhook-config`).** Rejected: the reason string is part of the FR-006 protocol; adding a variant requires the skill to handle it. Out of scope.

## R6: Do we need to gate the stage on `deps.gh != null`?

**Decision**: Yes. Both `targets` and `runner` are optional on `ChannelDiscoveryInput`; when either is absent, the webhook-config stage is skipped (silent fall-through to walk-up).

**Rationale**:

- Today's smee-mode is already gated on `deps.gh != null` (`doorbell.ts:382`). If `gh` is absent, discovery today short-circuits to `null` and the doorbell goes straight to poll-fallback. Preserve that.
- The `resolveEpic` call inside `webhook-target-resolver.ts` requires a `GhWrapper`; without one, `targets` is `[]` and the stage no-ops.
- Unit tests for the FS stages can continue to construct `ChannelDiscoveryInput` without `runner`/`targets` — no test refactor.

**Alternatives considered**:

- **Skip only when `targets` is empty.** Rejected: it's the same net effect, but coupling to `runner` presence as well makes the intent explicit ("no runner → no network calls").
- **Wire `discoverChannel` to always call `resolveWebhookTargets`.** Rejected: adds a `resolveEpic` call to callers that don't need smee-mode (agency#431 test seams, non-cockpit-mode invocations). Only the smee-attempt path benefits.

## Key sources / references

- Spec: `specs/988-summary-cockpit-auto-doorbell/spec.md`
- Clarifications: `specs/988-summary-cockpit-auto-doorbell/clarifications.md`
- Existing discovery: `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`
- Existing smee-mode gate: `packages/generacy/src/cli/commands/cockpit/doorbell.ts:375-393`
- Orchestrator hooks reader: `packages/orchestrator/src/services/webhook-setup-service.ts:708-751`
- `resolveEpic` output shape: `packages/cockpit/src/resolver/types.ts` (`ResolvedEpic`, `IssueRef`)
- `CommandRunner` contract: `packages/cockpit/src/gh/command-runner.ts`
- FR-006 stderr protocol: `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts:35`
- Snappoll validation output (in spec): `gh api repos/christrudelpw/snappoll/hooks --jq …` returning `active:true, url:"https://smee.io/…"`.
