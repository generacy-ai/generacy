# Implementation Plan: Base-advance re-validate + bounded validate-fix cycle

**Feature**: Auto-resume stale `failed:validate` reds when a base branch advances (re-triggers validate against a fresh merge-preview) and, only if the red persists, run exactly one autonomous fix-cycle attempt bounded by an evidence hash. Fixes the P2-issue stranding at `failed:validate` observed in the cockpit v1.5 auto-mode smoke test (tetrad-development#92, finding #43).
**Branch**: `892-found-during-cockpit-v1`
**Date**: 2026-07-09
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Two independent behaviors gated by ordering:

**(a) Base-advance re-validate.** New `BaseAdvanceMonitorService` runs on the existing ~60 s monitor cadence. Every cycle it enumerates open PRs currently at `failed:validate` grouped by `(repo, baseBranch)`, resolves the current `origin/<base>` head SHA once per group, and for each PR whose *last-seen* base SHA differs from the current one, enqueues a single `resume` for that issue keyed on `(issue, newBaseSha)`. The new SHA is both the trigger and the dedupe key — no explicit sibling-membership / milestone / label construct (per Q1→D). Redis key layout `base-advance-tracker:<owner>:<repo>:<issue>:<baseSha>` sits alongside `PhaseTrackerService`'s existing `phase-tracker:` namespace, so cross-service DEL storms cannot collide. Enqueue delegates to the same `cockpit resume` verb the operator uses manually (companion issue; the monitor imports its handler, not a shell-out). Convergence property: dependency-ordered sibling merges naturally unblock dependents one SHA advance at a time; no ordering machinery.

**(b) Bounded validate-fix cycle.** New `ValidateFixHandler` (worker-side) mirrors `PrFeedbackHandler`'s spawn→commit→push→re-check plumbing. Triggered *only* when a `failed:validate` red re-runs on a fresh merge-preview and still fails (i.e., (a) already ruled out staleness). Before spawning:
1. Compute an **evidence hash** — SHA-256 of a structured extract (sorted `{failing_test_name | failing_module_path}` list + first error line per failure, ANSI/timestamp/absolute-path/PID normalized). Full stdout goes into the prompt; the hash is identity, not payload (Q3→B).
2. `PhaseTrackerService.isDuplicate(owner, repo, issue, `validate-fix:${hash}`)` — same evidence hash → escalation, no spawn (Q3→B "collisions err safe").
3. Sibling-duplication guard — `gh pr diff --name-only` across every open PR to the same base branch (Q4→A). File-set is passed to the fix agent as a "do-not-create" list.

Spawn identity: fresh worker on the *same* role that produced the red (inherits `credentialRole`, tools, prompt shell) (Q5→A). Implementation shares `PrFeedbackHandler`'s launcher plumbing (~line 423), swapping intent kind (`validate-fix`) and the evidence-source prompt. Termination discipline (#883): agent must change the tree or the cycle halts and adds `blocked:stuck-validate-fix` for human escalation; re-validate after push; still red → `failed:validate` re-applied + alert. Observability comes from a distinct event tag (`cluster.validate-fix`), not a distinct role.

**Ordering invariant.** (a) MUST run before (b) is judged. The base-advance re-validate is a cheap no-op when the preview didn't materially change; skipping it and firing (b) directly on the stale evidence means the fix agent tries to "fix" phantom integration reds — the exact failure mode the spec warns against. Enforced structurally: the `ValidateFixHandler` is invoked *only* from the resume-driven validate re-run's own `onError('validate')` path, never from the monitor directly.

Scope: three new files (`BaseAdvanceMonitorService`, `ValidateFixHandler`, evidence-hash helper), two modified worker call-sites, one new `GitHubClient` method (`getRefHeadSha`), one new Redis key namespace. No new dependencies.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (orchestrator package baseline).
**Primary Dependencies**: existing — `ioredis` (via `PhaseTrackerService`), `pino` (Logger), `gh` CLI (via `GhCliGitHubClient`), `vitest`. No new deps.
**Storage**: Redis. New key namespace `base-advance-tracker:<owner>:<repo>:<issue>:<baseSha>` (TTL 24 h — same as `phase-tracker:`) and `phase-tracker:<owner>:<repo>:<issue>:validate-fix:<hash>` (reuses `PhaseTrackerService`, TTL 24 h). Existing `phase-tracker:` keyspace unchanged.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/services/__tests__/base-advance-monitor-service.test.ts` — NEW. SHA-change detection, dedupe on repeat cycle, no-op on unchanged SHA, empty open-PR list, PR base-branch grouping, per-group SHA resolution failure (skip group + warn), enqueue-side error (retry next cycle since we haven't marked processed).
- `packages/orchestrator/src/worker/__tests__/validate-fix-handler.test.ts` — NEW. Evidence hash construction from a canned stdout blob, hash equality across cosmetic re-runs (durations/PIDs/paths differ, hash stable), duplicate-hash → escalation (no spawn), sibling-duplication guard (agent prompt includes owned-file list), no-diff after spawn → `blocked:stuck-validate-fix`, re-validate red → `failed:validate` re-applied.
- `packages/orchestrator/src/worker/__tests__/evidence-hash.test.ts` — NEW. Pure-function normalization tests: ANSI stripped, `\d{4}-\d{2}-\d{2}T…` replaced, absolute paths → repo-relative, PIDs/tmp dirs collapsed to placeholders, sort stability, `next build` shape, `vitest run` shape, empty-stdout hash.
- `packages/orchestrator/src/services/__tests__/phase-tracker-service.test.ts` — MINIMAL EXTENSION. Add one case: `isDuplicate(_, _, _, 'validate-fix:abc123')` behaves identically to existing phase-namespaced calls (namespace is opaque to the tracker). Guard against future refactor breaking key layout.
- `packages/orchestrator/src/__tests__/base-advance-e2e.test.ts` — NEW. End-to-end scenario matching spec regression tests 1 + 4: three cross-dependent siblings, all red at `failed:validate`; simulate sibling #1 merge → base SHA change → monitor picks up → re-validate on #2 → green → merges → re-validate on #3 → green → merges. Uses in-memory `ioredis-mock` + stubbed `GhCliGitHubClient`.
- `packages/orchestrator/src/services/__tests__/label-monitor-service.test.ts` — UNCHANGED. `LabelMonitorService` gets no new responsibilities; the `waiting-for:` / `completed:` pair path is orthogonal.

**Target Platform**: Node orchestrator + worker inside cluster container. Redis is the shared coordination store.
**Project Type**: Monorepo package (`packages/orchestrator`) + one new `GitHubClient` interface method exported from `packages/workflow-engine/src/actions/github/client/`. No cross-package data model changes.
**Performance Goals**:
- Base-advance monitor: one `gh api repos/{o}/{r}/commits/{base}` call per unique `(repo, base)` per cycle (~60 s), regardless of PR count in the group. For a cluster with N failing PRs across K unique `(repo, base)` groups: K API calls / cycle, not N. Enqueue is O(N) but hits the local queue, not the network.
- Validate-fix spawn: rare (only when re-validate stays red). N `gh pr diff --name-only` calls per spawn (N = open PRs to same base). Acceptable — spawns are minutes-apart at worst.
- Evidence hash: purely local, O(stdout length). Bounded by CLI output size (~few MB max), negligible.

**Constraints**:
- Zero new dependencies.
- `PhaseTrackerService` interface + implementation unchanged. New key namespace `base-advance-tracker:` requires no schema change (namespace is a string prefix).
- `LabelManager` unchanged. `onError('validate')` still applies `failed:validate`; the re-validate on base advance clears it as a side effect of the next `onStart(phase)` (existing behavior).
- Base-advance monitor is **read-only** wrt GitHub state — it never applies/removes labels directly. It enqueues via the same `cockpit resume` handler; label transitions happen on the resume path (existing behavior).
- Fix cycle spawns the *same role* that produced the red (Q5→A). `credentialRole` inheritance follows `PrFeedbackHandler`'s `buildLaunchCredentials(this.config.credentialRole)` pattern.
- Sibling-duplication guard is on-demand (Q4→A). No cached manifest, no queue-side coherence.
- Ordering: fix cycle NEVER fires on a red that hasn't first been re-validated on a fresh preview. Enforced by wiring the `ValidateFixHandler` only into the resume-driven validate re-run's `onError('validate')` — never into the monitor's own enqueue path.
- Evidence hash NEVER used to skip a spawn on a *first* red (only on repeats). First-time reds always spawn; the hash bounds subsequent attempts.
- Blast radius: the base-advance monitor observes SHAs and enqueues resumes. Failure modes cap at "did not re-arm a stale red" (visible as a stuck issue, same as today) — never at "clobbered a green branch."

**Scale/Scope**: 3 new source files (~300 LOC prod), 5 test files (~450 LOC tests), 1 modified `GitHubClient` method (+ ~20 LOC). No config surface changes (poll cadence reuses `LabelMonitorService.pollIntervalMs`).

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, clarifications, and adjacent completed epics (#849, #824, #822):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | Two concrete classes (`BaseAdvanceMonitorService`, `ValidateFixHandler`) + one pure function (`hashValidationEvidence`). No plugin hook, no config surface, no interface split. Both classes exist because they encode distinct lifecycle contracts — (a) is monitor-side, poll-driven, read-only wrt GitHub; (b) is worker-side, spawn-driven, tree-mutating. Combining them would break the ordering invariant. |
| Match spec Q&A intent, not just the letter | PASS | Q1→D (base-branch scoping, not epic membership) — `BaseAdvanceMonitorService.groupPrsByBase()` is the whole implementation surface for this. Q2→B (poll SHA on 60 s cadence) — `pollCycle()` is the whole implementation surface. Q3→B (structured evidence hash) — `hashValidationEvidence()` is a pure function returning the SHA-256 hex string. Q4→A (on-demand `gh pr diff --name-only` per open PR to same base) — `collectSiblingOwnedFiles()` in the fix handler. Q5→A (same role, same credentials) — `ValidateFixHandler.spawnValidateFixer()` reuses `buildLaunchCredentials(this.config.credentialRole)`. |
| No backwards-compat shims for removed code | PASS | Nothing removed. Two new files, one new method on an interface (opt-in via new call site — no existing callers). |
| Tests hit real behavior, not mocks-of-mocks | PASS | Evidence hash tested with real canned CLI output blobs (fixtures in `__tests__/fixtures/`). E2E test uses real `ioredis-mock` (already wired in worker suite) + stubbed `GhCliGitHubClient` at the *command boundary* (returns canned `gh` stdout), not stubbed higher up. Base-advance monitor tests use fake timers + real `PhaseTrackerService`. |
| Structured logging conventions | PASS | Both new services use the existing `logger.info(obj, msg)` / `logger.warn(obj, msg)` shape. Structured fields: `owner`, `repo`, `issueNumber`, `baseBranch`, `oldSha`, `newSha`, `evidenceHash`, `siblingFileCount`, matching adjacent monitor/handler cadence. |
| Don't add features beyond what the task requires | PASS | No auto-clearing of `failed:validate` outside the resume path (existing behavior handles it). No new UI signal, no epic-completion attribution, no cross-epic scope. Sibling-duplication guard does NOT phase-filter (Q4→A explicit). Evidence hash does NOT include stack traces or line-column pairs (only test name / module path / first error line). No retry loop inside the fix cycle — exactly one attempt (spec §Proposal(b)). |
| No unauthorized destructive git actions | PASS | Base-advance monitor: read-only. Fix cycle: `git add . && git commit && git push` on the PR's own branch (same as `PrFeedbackHandler` today). No force-push, no rebase, no base-branch mutation. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/892-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rejected alternatives per Q1–Q5
├── data-model.md        # Phase 1 output — Redis key layouts, evidence extract shape, event payloads
├── quickstart.md        # Phase 1 output — repro finding #43, verify fix converges siblings
├── contracts/
│   ├── base-advance-monitor.md         # Monitor lifecycle, SHA-poll contract, dedupe key format (FR-001, FR-002)
│   ├── evidence-hash.md                # Normalization rules + SHA-256 input shape (FR-003, Q3→B)
│   └── validate-fix-handler.md         # Spawn identity, sibling guard, termination discipline (FR-004, FR-005, Q4→A, Q5→A)
└── checklists/          # (empty — none required by /plan)
```

### Source Code (repository root)

```text
packages/orchestrator/src/
├── services/
│   ├── base-advance-monitor-service.ts   # NEW — poll base SHA per (repo, base) group, enqueue resume on change (Q1→D, Q2→B, FR-001, FR-002)
│   ├── phase-tracker-service.ts          # UNCHANGED — new `base-advance-tracker:` and `validate-fix:` keys use the same `set/exists/del` surface
│   └── __tests__/
│       ├── base-advance-monitor-service.test.ts  # NEW (~180 LOC)
│       └── phase-tracker-service.test.ts         # +1 case: opaque namespace regression guard
├── worker/
│   ├── validate-fix-handler.ts           # NEW — spawn→commit→push→re-validate on same role, evidence-hash bounded (Q3→B, Q4→A, Q5→A, FR-003, FR-004, FR-005)
│   ├── evidence-hash.ts                  # NEW pure function — hashValidationEvidence(stdout) → { hash, extract } (FR-003, Q3→B)
│   ├── claude-cli-worker.ts              # MODIFIED — inject ValidateFixHandler into PhaseLoop deps; wired only on validate re-run's onError path
│   ├── pr-feedback-handler.ts            # UNCHANGED — reference implementation for spawn plumbing (validate-fix-handler mirrors its shape)
│   └── __tests__/
│       ├── validate-fix-handler.test.ts  # NEW (~200 LOC) + fixtures/ (canned next-build + vitest stdout blobs)
│       └── evidence-hash.test.ts         # NEW (~80 LOC)
├── server.ts                             # MODIFIED — instantiate BaseAdvanceMonitorService alongside LabelMonitorService (mirrors line ~347 wiring)
└── __tests__/
    └── base-advance-e2e.test.ts          # NEW — 3-sibling convergence scenario (SC-004 gate)

packages/workflow-engine/src/actions/github/client/
├── interface.ts                          # MODIFIED — add `getRefHeadSha(owner, repo, ref): Promise<string>` to GitHubClient
└── gh-cli.ts                             # MODIFIED — implement getRefHeadSha via `gh api repos/{o}/{r}/commits/{ref} --jq .sha`
```

**Structure Decision**: Split by lifecycle boundary — the monitor lives in `services/` (poll-driven, singleton, boot-time) and the handler lives in `worker/` (spawn-driven, per-item, worker-scoped). This mirrors the existing split between `LabelMonitorService` (services/) and `PrFeedbackHandler` (worker/). Combining them into one file would break the ordering invariant by making it structurally possible to skip (a) and fire (b) directly. The evidence hash lives with the handler (single caller, tightly coupled) — a separate `evidence-hash.ts` because it's a pure function with its own test surface. `getRefHeadSha` goes on the `GitHubClient` interface so future callers (dashboard status, epic-completion attribution) don't re-invent it.

## Design Overview

### `BaseAdvanceMonitorService` — poll loop shape

Follows `LabelMonitorService` pattern (~ `packages/orchestrator/src/services/label-monitor-service.ts:456` and `PrFeedbackMonitorService.poll()`):

```ts
class BaseAdvanceMonitorService {
  constructor(
    private readonly logger: Logger,
    private readonly createClient: GitHubClientFactory,
    private readonly config: BaseAdvanceMonitorConfig,     // { pollIntervalMs, repositories, concurrency }
    private readonly phaseTracker: PhaseTracker,
    private readonly enqueueResume: (item: ResumeItem) => Promise<void>,
    private readonly tokenProvider?: () => Promise<string | undefined>,
    private readonly authHealth?: AuthHealthSink,          // #762 backstop, same pattern
  ) {}

  async startPolling(): Promise<void> { /* AbortController, setInterval-style loop, per-cycle poll() */ }
  async stopPolling(): Promise<void> { /* signal abort + await inflight */ }

  private async pollCycle(): Promise<void> {
    for (const { owner, repo } of this.config.repositories) {
      await this.pollRepo(owner, repo);   // semaphore-limited
    }
  }

  private async pollRepo(owner: string, repo: string): Promise<void> {
    const github = await this.createClient({ owner, repo, tokenProvider: this.tokenProvider });
    const failingPRs = await this.listFailingValidatePRs(github, owner, repo);
    const byBase = groupBy(failingPRs, pr => pr.base);
    for (const [baseBranch, prs] of byBase) {
      const newSha = await this.safeGetHeadSha(github, owner, repo, baseBranch);
      if (!newSha) continue;                      // per-group SHA fetch failure → warn, skip group
      for (const pr of prs) {
        const key = `base-advance-tracker:${owner}:${repo}:${pr.issueNumber}:${newSha}`;
        if (await this.phaseTracker.isDuplicateRaw(key)) continue;   // already re-armed for this SHA
        await this.enqueueResume({ owner, repo, issueNumber: pr.issueNumber, reason: 'base-advance', newSha });
        await this.phaseTracker.markProcessedRaw(key);               // mark after successful enqueue
      }
    }
  }
}
```

Notes:
- `isDuplicateRaw` / `markProcessedRaw` accept the full pre-built key. Two thin passthroughs on `PhaseTrackerService` — internally identical to today's `isDuplicate(owner, repo, issue, phase)` but with the caller controlling the namespace. Alternative considered: pass `('base-advance', `${baseSha}`)` as a compound phase; rejected because it re-introduces the ambiguity the plan is trying to shed (base-advance keys are NOT phase-scoped in the workflow sense — a single issue can be re-armed for many SHAs).
- `listFailingValidatePRs` uses `github.listOpenPullRequests(owner, repo)` + `github.listIssueLabels(prIssueNumber)` filter for `failed:validate`. No new REST call — same pattern as `LabelMonitorService.pollRepo`.
- Per-group SHA resolution failure (network blip, credential expiry) → `authHealth.recordResult({ ok: false, statusCode })` (#762 hook) + `warn` + skip that group. Other groups in the same cycle proceed. Next cycle retries — the key was never written.
- Enqueue error → do NOT mark processed. Next cycle retries the same `(issue, newSha)` — SC-002 "exactly once per new SHA" is measured across cycles, not within one cycle.
- Boot behavior: on startup, `phaseTracker` has no keys for the current `newSha` for any issue → *every* currently-failing PR gets one re-arm. This is the intended "operator restarts cluster, previously stranded issues re-attempt" behavior. Feature-flag not required — cost is bounded (K API calls + N queue enqueues) and the resume path is idempotent (same evidence → escalation).

### `ValidateFixHandler` — spawn shape

Mirrors `PrFeedbackHandler` (`packages/orchestrator/src/worker/pr-feedback-handler.ts:73`) with three differences:

```ts
class ValidateFixHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly agentLauncher: AgentLauncher,
    private readonly phaseTracker: PhaseTracker,
    private readonly logger: Logger,
    private readonly emitEvent?: (channel: string, payload: unknown) => void, // cluster.validate-fix
  ) {}

  async handle(
    item: QueueItem,
    checkoutPath: string,
    validateEvidence: { stdout: string; stderr: string; exitCode: number },
    github: GitHubClient,
  ): Promise<void> {
    const { hash, extract } = hashValidationEvidence(validateEvidence.stdout);
    const dupKey = `validate-fix:${hash}`;

    if (await this.phaseTracker.isDuplicate(item.owner, item.repo, item.issueNumber, dupKey)) {
      // Same red as before — escalate. FR-005 escalation gate.
      await this.applyEscalationLabel(github, item);
      this.emitEvent?.('cluster.validate-fix', { status: 'escalated', reason: 'duplicate-evidence-hash', evidenceHash: hash, ...item });
      return;
    }
    await this.phaseTracker.markProcessed(item.owner, item.repo, item.issueNumber, dupKey);

    const siblingFiles = await this.collectSiblingOwnedFiles(github, item.owner, item.repo, item.baseBranch, item.prNumber);
    const prompt = this.buildFixPrompt(validateEvidence, extract, siblingFiles);

    const handle = await this.agentLauncher.launch({
      intent: { kind: 'validate-fix', prNumber: item.prNumber, prompt, evidenceHash: hash },
      cwd: checkoutPath,
      env: {},
      credentials: buildLaunchCredentials(this.config.credentialRole),  // Q5→A: same role
    });
    const exitCode = await handle.process.exitPromise;

    const hasChanges = await this.commitAndPushChanges(checkoutPath, item, `validate-fix: ${hash.slice(0, 12)}`);
    if (!hasChanges) {
      // #883 termination discipline: no-diff → stop. Human escalation.
      await this.applyStuckLabel(github, item);
      this.emitEvent?.('cluster.validate-fix', { status: 'blocked', reason: 'no-diff', evidenceHash: hash, ...item });
      return;
    }
    // Re-validate happens on the resume path (LabelMonitorService picks up completed:validate-fix → re-runs validate).
    // Not this handler's responsibility. Emitting a success event here is provisional (validate may still fail).
    this.emitEvent?.('cluster.validate-fix', { status: 'attempted', evidenceHash: hash, ...item });
  }

  private async collectSiblingOwnedFiles(github, owner, repo, baseBranch, ownPrNumber): Promise<string[]> {
    const openPRs = await github.listOpenPullRequests(owner, repo);
    const siblings = openPRs.filter(pr => pr.base === baseBranch && pr.number !== ownPrNumber);
    const files: string[] = [];
    for (const pr of siblings) {
      const names = await github.prDiffNames(`${owner}/${repo}`, pr.number);  // Q4→A: on-demand
      files.push(...names);
    }
    return [...new Set(files)];
  }
}
```

Notes:
- **Wiring**: `PhaseLoop` calls `ValidateFixHandler.handle()` from inside the `catch` block around the validate CLI, immediately after capturing `stdout`/`stderr`, and *only* on the resume-driven re-run (detected via `WorkerContext.resumeReason === 'base-advance'`). First-time validate reds still go straight to `LabelManager.onError('validate')` — the fix cycle is a re-run behavior, not a first-run behavior.
- **Role inheritance (Q5→A)**: `this.config.credentialRole` comes from `WorkerConfig`, same as `PrFeedbackHandler`. No new role definition, no new credential wiring.
- **Sibling guard (Q4→A)**: N `prDiffNames` calls per invocation (N = open PRs to same base). No cache. Files passed into the fix prompt as a "do-not-create" list — enforcement is prompt-side, not filesystem-side. Rationale: a filesystem block would need mutation on the checkout, breaking `PrFeedbackHandler`'s spawn model; the prompt guidance is what actually prevents the duplication (agents don't create files they're told exist elsewhere). Post-hoc guard: after commit, `git diff --name-only` intersected with `siblingFiles` → if any overlap, revert commit + escalation. Deferred to Phase 2 tasks if empirical evidence shows the prompt-only guard leaks.
- **Emit-event tag**: `cluster.validate-fix` is a new channel. Payload shape defined in `contracts/validate-fix-handler.md`. Cloud-side consumer is out of scope for #892 (cluster emits, cloud subscribes on its own timeline).

### `hashValidationEvidence` — evidence hash pure function

`packages/orchestrator/src/worker/evidence-hash.ts`:

```ts
export interface EvidenceExtract {
  failures: Array<{ id: string; firstError: string }>;  // sorted by id
}

export interface EvidenceHashResult {
  hash: string;              // SHA-256 hex
  extract: EvidenceExtract;  // canonical input to the hash — for logging / prompt inclusion
}

export function hashValidationEvidence(stdout: string): EvidenceHashResult;
```

Normalization pipeline (applied to stdout before extraction):
1. Strip ANSI escape sequences (`\x1b\[[0-9;]*m` and CSI variants).
2. Replace ISO-8601 timestamps (`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?`) with `<TS>`.
3. Replace absolute paths (`(/[a-zA-Z0-9._-]+)+`) with `<PATH>` — repo-relative paths (starting with `./` or bare `src/…`) preserved.
4. Replace PIDs — sequences after `pid=` / `PID:` / `[<digits>]` — with `<PID>`.
5. Replace temp-dir names (`/tmp/[a-zA-Z0-9_-]+`, `T-[a-zA-Z0-9]+`) with `<TMP>`.
6. Replace port numbers in `localhost:` / `127.0.0.1:` with `<PORT>`.

Extraction:
- For `next build`: match `Cannot find module '(.*?)'` blocks and `Type error: (.*?) at .*?/(.*?):(\d+):(\d+)`; `id` = `module:${modulePath}` or `type:${filePath}:${errorSummary}`; `firstError` = the matched error line, un-decorated.
- For `vitest`: match ` × ` failing test lines; `id` = `test:${testName}`; `firstError` = the first indented line following.
- Fallback: if no known pattern matches, `id` = SHA-256 first 16 hex of the whole normalized transcript, `firstError` = first line of normalized stdout. Ensures every red produces *some* hash — collisions err safe (Q3→B).

`hash` = SHA-256 hex of `JSON.stringify({ failures: extract.failures })` where `failures` is sorted by `id`.

Sorting stability + JSON.stringify canonicalization: guarantees the hash is deterministic across process runs. No `Date.now()`, no `Math.random()`, no environment leakage.

### `GitHubClient.getRefHeadSha` — new method

`packages/workflow-engine/src/actions/github/client/interface.ts`:

```ts
export interface GitHubClient {
  // ... existing methods
  /**
   * Returns the current head commit SHA of a branch or ref.
   * Used by BaseAdvanceMonitorService to detect base-branch advances.
   * @param ref - e.g. "develop", "main", "release/v2"
   * @throws GhAuthError on HTTP 401 (feeds #762 auth-health backstop)
   */
  getRefHeadSha(owner: string, repo: string, ref: string): Promise<string>;
}
```

`gh-cli.ts` implementation:

```ts
async getRefHeadSha(owner: string, repo: string, ref: string): Promise<string> {
  const token = await this.tokenProvider?.();
  const result = await executeCommand(
    'gh', ['api', `repos/${owner}/${repo}/commits/${ref}`, '--jq', '.sha'],
    { env: token ? { GH_TOKEN: token } : {}, timeout: 30_000 },
  );
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid SHA for ${owner}/${repo}@${ref}: ${sha.slice(0, 80)}`);
  return sha;
}
```

Same `executeGh` 401 → `GhAuthError` path (per #762) as other client methods.

### Non-changes (deliberate)

- **`LabelMonitorService`** — untouched. The `waiting-for:` / `completed:` pair path already handles resume enqueue; base-advance monitor delegates to that path (spec: "via the `cockpit resume` verb, filed separately").
- **`PhaseTrackerService`** — no interface change. Two new *thin passthroughs* (`isDuplicateRaw`, `markProcessedRaw`) accept pre-built keys. Rejected alternative: extend `isDuplicate`'s phase argument to accept slashes — pollutes the key layout for a single caller.
- **`LabelManager`** — untouched. `failed:validate` is applied via `onError('validate')` (existing behavior); cleared implicitly by the next `onStart(phase)` on resume.
- **`WorkerConfig`** — no new fields. `credentialRole` already covers the fix-cycle spawn (Q5→A).
- **`.agency/config.yaml`** — no new fields. Poll cadence inherits from `LabelMonitorService.pollIntervalMs`.
- **`AgentLauncher`** — no new plugin. New intent kind `validate-fix` handled by existing plugin dispatch (per `packages/orchestrator/src/launcher/`; plugins receive the intent kind and route to the same worker prompt shell as `pr-feedback`).
- **Retroactive repair** — spec §Out of Scope: existing stranded issues on cluster boot will re-arm exactly once when the monitor first observes their base SHAs. This is the intended recovery path, not a separate repair job.

## Complexity Tracking

*Constitution Check passed; no violations.*

- 3 new files (production): `base-advance-monitor-service.ts`, `validate-fix-handler.ts`, `evidence-hash.ts`.
- 5 new files (tests + fixtures).
- 1 new `GitHubClient` interface method (`getRefHeadSha`) — one impl in `gh-cli.ts`.
- 2 new `PhaseTrackerService` thin passthroughs (`isDuplicateRaw`, `markProcessedRaw`) — no interface split, no schema change.
- 1 new Redis key namespace (`base-advance-tracker:`). 1 new phase-scope suffix (`validate-fix:<hash>`) inside existing `phase-tracker:` namespace.
- 1 new relay event channel (`cluster.validate-fix`). Cloud-side consumer out of scope.
- 0 new dependencies. 0 new config surface. 0 removed code.

## Risk / Rollback

- **Risk 1 — SHA storm on cluster boot**: First cycle after cluster start re-arms every currently `failed:validate` PR (one enqueue per PR, since no `base-advance-tracker:` keys exist yet). For a project with M stranded PRs, M queue enqueues in one cycle. **Mitigation**: existing queue in-flight dedupe (#879) collapses the storm to K workers in flight (K = queue concurrency). The resume path is idempotent — same evidence → escalation. Bounded blast radius: at most one Claude spawn per PR, at most one duplicate-hash escalation per PR.
- **Risk 2 — Sibling-duplication guard is prompt-only**: The agent is *told* which files exist on siblings but nothing filesystem-side blocks a create. **Mitigation**: post-commit `git diff --name-only` ∩ `siblingFiles` check. If overlap, revert commit + escalation label. Deferred to Phase 2 tasks; empirical evidence from initial rollout drives whether this is needed. Prompt guidance historically holds for well-scoped file lists.
- **Risk 3 — Base-branch SHA fetch failure blocks a whole group**: One `gh api commits/{ref}` call gates the re-arm for every failing PR to that base. If the call fails (rate limit, credential expiry, network blip), all PRs to that base miss this cycle. **Mitigation**: next 60 s cycle retries; `authHealth.recordResult(_, { ok: false, statusCode: 401 })` (#762) surfaces persistent auth failures at the same cadence as `LabelMonitorService`. The dedupe key was never written for the failed group, so no permanent state.
- **Risk 4 — Evidence hash false collision**: Two genuinely different reds normalize to the same hash → second red is incorrectly escalated instead of getting its own attempt. **Mitigation**: Q3→B explicit "collisions err safe" — escalation is the human gate; the failure mode is "operator investigates one issue" not "silent regression." Fallback hash path (SHA-256 first 16 hex of whole normalized transcript when no known error pattern matches) minimizes collision risk for exotic reds. Adding new CLI shapes to the extraction pipeline is additive.
- **Risk 5 — Fix cycle runs on phantom integration red despite ordering invariant**: A `ValidateFixHandler` misuse (invoked from wrong site) could spawn on a stale-preview red, "fix" phantom issues, then duplicate a sibling's file. **Mitigation**: structural — the handler is invoked from exactly one call site (`PhaseLoop` validate `catch` block, gated by `resumeReason === 'base-advance'`). Test `validate-fix-handler.test.ts` asserts the handler refuses to spawn without this reason field (defense in depth). Reviewer checklist: any new `ValidateFixHandler` call site is a spec violation.
- **Risk 6 — `cockpit resume` verb not yet implemented (companion issue)**: Spec explicitly notes the resume verb is filed separately. Without it, this feature has nothing to enqueue into. **Mitigation**: the base-advance monitor's `enqueueResume` callback is a wired dependency — production wiring in `server.ts` uses the concrete resume handler, tests inject a stub. Landing #892 before the resume verb ships gives us an idle monitor + no fix behavior — degrades to "same as today." Landing them in either order is safe.
- **Rollback**: revert the three new source files + the one modified interface method + the `server.ts` wiring line + `claude-cli-worker.ts` fix handler wiring. Zero data migration. Existing `base-advance-tracker:` and `validate-fix:` Redis keys age out on TTL (≤24 h). Zero relay-payload change (new event tag is additive — cloud subscribers on other channels are unaffected).
