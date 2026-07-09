# Quickstart: Base-advance re-validate + bounded validate-fix cycle

**Feature**: `892-found-during-cockpit-v1`
**Audience**: Cluster operators + speckit-feature maintainers.

## What it does

Two behaviors, ordering-dependent:

- **(a) Base-advance re-validate.** When any commit lands on a base branch (`develop`, `main`, etc.), the orchestrator's `BaseAdvanceMonitorService` polls (~60 s cadence) and — for every open PR at `failed:validate` targeting that base — enqueues one `cockpit resume` per new base SHA. This automatically un-strands issues whose validate red was caused by an unmerged sibling.
- **(b) Bounded validate-fix cycle.** If a `failed:validate` red *persists* on a fresh merge-preview, the worker runs exactly one autonomous fix attempt on the same role that produced the red, bounded by an evidence hash (SHA-256 of the failure fingerprint). Same red twice → escalation, no re-spawn.

## Installation

No config changes required. Feature ships as part of the orchestrator package; wiring is in `packages/orchestrator/src/server.ts` (auto-instantiated when `redis` and `labelMonitor` config sections are present — same conditions as `LabelMonitorService`).

Dependencies (all pre-existing):

- Redis reachable at `config.redis.url`.
- `gh` CLI in `$PATH` (for `getRefHeadSha` and `prDiffNames`).
- Existing `credentialRole` on `WorkerConfig` (for fix-cycle spawn — inherits from the validate that produced the red).

## Verification: reproduce finding #43 and confirm the fix

The empirical anchor for this feature is finding #43 in cockpit v1.5 auto-mode smoke test (tetrad-development#92): three P2 sibling issues stranded at `failed:validate` because one owns a file the others import.

### 1. Set up two cross-dependent PRs

In a scratch repo:

- **PR A** creates `src/components/Foo.tsx` and adds an export.
- **PR B** imports `Foo` from `@/components/Foo` in a test file.

Both PRs target `develop`. Neither is merged.

### 2. Run validate on PR B

```bash
cd /workspace/scratch-repo
git checkout pr-b-branch
gh pr checkout <pr-b-number>
# Simulate the merge-preview: merge develop into the branch without committing
git fetch origin develop
git merge --no-commit --no-ff origin/develop
pnpm build   # or your validate command
```

Expected: `Cannot find module '@/components/Foo'`. Red.

### 3. Apply `failed:validate` and observe stranding (pre-fix baseline)

```bash
gh pr edit <pr-b-number> --add-label failed:validate
```

Pre-fix: PR B sits at `failed:validate` forever. Even after PR A merges to `develop`, PR B is not re-armed.

### 4. Merge PR A → observe re-validate (with fix)

```bash
gh pr merge <pr-a-number> --squash
```

Within ~60 s, orchestrator logs should show:

```json
{"level":"info","event":"base-advance-detected","owner":"…","repo":"…","baseBranch":"develop","oldSha":"…","newSha":"…"}
{"level":"info","event":"base-advance-enqueue","owner":"…","repo":"…","issueNumber":<pr-b-issue>,"newSha":"…","reason":"base-advance"}
```

PR B transitions `failed:validate` → `phase:validate` (via existing `LabelManager.onStart` on the resume path) → validate re-runs → passes (`Foo` now resolves via the newly-merged `develop`) → `completed:validate`.

### 5. Verify dedupe

Query Redis while the resume is in flight:

```bash
redis-cli --scan --pattern 'base-advance-tracker:*'
# should show a key like base-advance-tracker:<owner>:<repo>:<issue>:<newSha>
```

Second `getRefHeadSha` for the same SHA on the next 60 s cycle: no re-enqueue (key gates it).

### 6. Verify fix cycle on a genuine red (rare path)

For the fix-cycle behavior:

1. Create a PR with a real code defect (e.g., syntax error in a source file).
2. Wait for validate to fail → `failed:validate`.
3. Manually advance `develop` (unrelated commit) to trigger the base-advance re-validate.
4. Validate re-runs → fails again on the same code defect (persists on fresh preview).
5. Worker computes evidence hash, checks `phase-tracker:validate-fix:<hash>` (absent), spawns fix agent on the same role.
6. Log events at `cluster.validate-fix`:
   ```json
   {"channel":"cluster.validate-fix","data":{"status":"attempted","evidenceHash":"<64-hex>","owner":"…","repo":"…","issueNumber":<n>,"prNumber":<n>}}
   ```
7. Fix agent commits + pushes → validate re-runs on the new tree → passes → `completed:validate`.

If the fix agent produces no diff (#883 termination):

```json
{"channel":"cluster.validate-fix","data":{"status":"blocked","reason":"no-diff",…}}
```

Issue gets `blocked:stuck-validate-fix` label. Manual operator action required.

If a re-red on the *same evidence hash* happens (agent thought it fixed the issue but didn't):

```json
{"channel":"cluster.validate-fix","data":{"status":"escalated","reason":"duplicate-evidence-hash",…}}
```

Issue gets `blocked:stuck-validate-fix`. No re-spawn.

## Available commands

### Log grep for base-advance activity

```bash
docker logs generacy-orchestrator 2>&1 | grep -E '"event":"base-advance-'
```

Fields to look for:
- `base-advance-detected` — SHA change observed.
- `base-advance-enqueue` — resume enqueued for an issue.
- `base-advance-skip-duplicate` — SHA already re-armed for this issue.

### Log grep for validate-fix activity

```bash
docker logs generacy-orchestrator 2>&1 | grep -E '"channel":"cluster.validate-fix"'
```

### Redis inspection

```bash
# Base-advance dedupe keys
redis-cli --scan --pattern 'base-advance-tracker:*'

# Validate-fix dedupe keys (evidence hashes seen)
redis-cli --scan --pattern 'phase-tracker:*:validate-fix:*'
```

### Manual re-arm (operator override)

Force a stranded issue to re-attempt after investigation:

```bash
# Clear both dedupe keys for the issue
redis-cli DEL 'base-advance-tracker:<owner>:<repo>:<issue>:<baseSha>'
redis-cli --scan --pattern 'phase-tracker:<owner>:<repo>:<issue>:validate-fix:*' | xargs -r redis-cli DEL

# Remove the stuck label; next monitor cycle will re-arm
gh pr edit <pr-number> --remove-label blocked:stuck-validate-fix --add-label failed:validate
```

## Troubleshooting

### "PR sits at `failed:validate` forever, no re-arm"

Check:
1. `BaseAdvanceMonitorService` is running: `docker logs generacy-orchestrator 2>&1 | grep -i BaseAdvanceMonitor | head`.
2. Redis reachable: `redis-cli PING` → `PONG`.
3. Base branch head SHA fetchable: `gh api repos/<owner>/<repo>/commits/<baseBranch> --jq .sha`.
4. `gh` token has repo read access — a 401 shows in logs as `GhAuthError` with `authHealth.recordResult`.

If (1)-(4) are healthy but the PR is not re-armed, check whether the base SHA is actually advancing. Same SHA → correctly a no-op.

### "Fix cycle keeps spawning on every re-run"

This should not happen — evidence hash bounds retries. If it does:
- `redis-cli --scan --pattern 'phase-tracker:*:validate-fix:*'` — expect one key per distinct red. If empty, Redis writes are failing (check `PhaseTrackerService` logs for `warn`).
- If Redis is fine, the evidence hash is likely varying across runs — inspect via `docker logs … | grep evidenceHash` and compare hashes. Cosmetic re-runs should produce identical hashes; if they don't, the normalization pipeline missed a per-run identifier. File a bug with two stdout blobs showing different hashes.

### "Fix agent duplicated a sibling's file"

The sibling-guard is prompt-side + post-hoc `git diff` check (see contracts/validate-fix-handler.md §7). If duplication slips through:
- Check the emitted event: `reason: 'sibling-file-overlap'` means the check caught it and reverted.
- If no such event and the file is genuinely duplicated on the branch: the agent bypassed the prompt guidance and the post-hoc check missed the overlap (rare — indicates the sibling PR was opened *between* `collectSiblingOwnedFiles` and the post-hoc check). Manual `git reset --hard` on the branch + re-arm.

### "Base-advance monitor emits `warn: getRefHeadSha 401`"

Credential expiry. See #762 auth-health backstop; check `github-auth` snapshot on `/health` endpoint. Cluster-side JIT git helper (#766) should refresh tokens automatically. If persistent, manual credential rotation via cockpit UI.

## Rollback

If the feature causes issues in production:

1. Revert the three new source files (`base-advance-monitor-service.ts`, `validate-fix-handler.ts`, `evidence-hash.ts`).
2. Revert `server.ts` wiring line and `claude-cli-worker.ts` handler injection.
3. Revert `GitHubClient.getRefHeadSha` interface + `gh-cli.ts` implementation.
4. Restart orchestrator.
5. Existing `base-advance-tracker:*` and `phase-tracker:*:validate-fix:*` keys age out on 24 h TTL. No data migration needed.

Behavior degrades to pre-fix: stranded issues stay stranded, operators manually `cockpit resume` + `redis-cli DEL` as needed.
