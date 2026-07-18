# Clarifications

**Feature**: `/cockpit:auto` doorbell — discover the smee channel from the repo webhook config
**Issue**: [generacy-ai/generacy#988](https://github.com/generacy-ai/generacy/issues/988)

## Batch 1 — 2026-07-18

### Q1: Discovery-stage ordering
**Context**: FR-004 proposes the order `env → webhook-config → workspace walk-up → workspace-absolute → cluster-internal file`, but the spec itself flags this with `[NEEDS CLARIFICATION: order confirmed?]` and the Assumptions/ordering-rationale entry argues webhook-config should precede FS because the mirror can go stale after an orchestrator re-registration. The counter-argument is that when the operator *does* share the cluster FS, the FS mirror is zero-network / zero-latency / zero-scope-risk and should probably win. This decides which stage the tests must assert as authoritative and how many `gh` calls happen in the FS-shared operator case.
**Question**: In what order should the stages fire?
**Options**:
- A: `env → webhook-config → walk-up → workspace-absolute → cluster-file` (spec default — webhook-config wins over FS because it is authoritative & current).
- B: `env → walk-up → workspace-absolute → cluster-file → webhook-config` (FS stages win when present — zero network cost / no scope requirement — webhook-config is the operator-session-only escape hatch).
- C: `env → webhook-config → cluster-file → walk-up → workspace-absolute` (webhook-config still first after env, but demote the workspace-mirror stages behind cluster-file since the mirror is the least-authoritative FS source).

**Answer**: *Pending*

### Q2: Multi-repo epic handling
**Context**: FR-008 is explicitly marked `[NEEDS CLARIFICATION — pick one repo, query all, or defer?]`. The doorbell resolves `refs` via `resolveRefSet` from `form.ref`; a multi-repo epic yields multiple `{owner, repo}` pairs. The spec's Assumptions default is "query only the primary repo", but that leaves cases where the primary repo has no smee hook while a sibling does (e.g. the tracking issue lives in a coordinator repo while the webhook is registered on a sub-repo). This shapes the FR-007 "one call at startup" cost budget: primary-only = 1 call, all-refs = N calls, first-match-wins-then-stop = 1..N calls.
**Question**: For multi-repo epics (multiple distinct `{owner, repo}` pairs in the resolved ref set), what should `webhook-config` discovery do?
**Options**:
- A: **Primary repo only** — query the repo hosting the epic tracking issue (`form.ref`'s repo); ignore sibling repos. Falls through to FS/poll if the primary has no smee hook. (Spec's current working default.)
- B: **All repos, first-match-wins** — iterate distinct repos in the resolved ref set in order, return the first repo that has a smee-pattern hook. Bounded at ≤N calls where N = distinct repos.
- C: **All repos, aggregate** — query every distinct repo and require all to point at the same smee URL; if they diverge, log a warning and fall through to FS/poll (defends against multi-repo epics wired to different channels).
- D: **Defer** — leave FR-008 as a P2 follow-up; ship the P1 path with primary-only behavior and revisit only if a real multi-repo epic exercises the gap.

**Answer**: *Pending*

### Q3: `ChannelDiscoveryInput` target-repo contract
**Context**: FR-003 leaves the input shape open: "either `owner`/`repo` fields or a `refs: string[]` array derived from `form.ref`". These are non-equivalent contracts: `{owner, repo}` means the caller owns the ref→repo parse and passes one target; `refs: string[]` means `discoverChannelUrl` owns parsing (via `parseIssueRef` or similar) and can iterate. This is coupled with Q2 — if multi-repo becomes the answer, `refs: string[]` becomes the only viable shape. If primary-only wins, `{owner, repo}` is simpler.
**Question**: What is the target-repo contract on `ChannelDiscoveryInput`?
**Options**:
- A: `{ owner: string; repo: string }` (single target) — caller (doorbell) owns ref→repo parsing; discovery stays repo-agnostic and repo-count-agnostic.
- B: `refs: string[]` (list) — discovery owns ref→repo parsing + dedup + iteration; enables Q2=B/C without a second refactor.
- C: `targets: Array<{ owner: string; repo: string }>` (pre-parsed list) — caller still owns parsing (aligned with existing `resolveRefSet` output), but discovery is multi-repo-ready; primary-only is expressed as `targets.length === 1`.

**Answer**: *Pending*

### Q4: Tie-break when multiple smee-pattern hooks exist
**Context**: FR-005 says "the first one whose `config.url` matches `SMEE_URL_PATTERN` is selected" and Assumptions notes "GitHub's `/hooks` endpoint returns hooks in creation order; stability across doorbell restarts is not required as long as *some* smee hook is picked". But if a repo has two smee hooks (stale registration + fresh one after an orchestrator restart), first-match may return the *stale* one — silently strangling the doorbell against a channel nobody delivers to. GitHub's API returns `active`, `updated_at`, and `id` per hook, so a deterministic tie-break is cheap.
**Question**: When multiple hooks match `SMEE_URL_PATTERN`, which one wins?
**Options**:
- A: **First match wins** (spec default) — accept non-determinism; documented as "unusual — indicates operator misconfiguration".
- B: **Prefer `active: true`** — filter to active hooks first, then take the first; falls back to any match if none are active.
- C: **Prefer most recently updated** — sort by `updated_at` desc, take the newest; deterministic and biases toward the current orchestrator registration.
- D: **B then C** — filter to `active: true`, then sort by `updated_at` desc; combines liveness + freshness.

**Answer**: *Pending*

### Q5: Timeout / cancellation for the `gh api …/hooks` call
**Context**: FR-007 says "exactly one `gh api …/hooks` call per doorbell startup", but the spec doesn't specify what happens if that call is slow (network stall, GitHub degraded, proxy hang). Today's FS stages are effectively bounded — filesystem reads either succeed, ENOENT immediately, or fail with an OS error. A hung `gh api` call would block doorbell startup indefinitely, delaying `armed\n` and the `source=…` line that agency#431/#437 parses. There's no explicit budget on how long the doorbell is allowed to spend on discovery before falling through to FS.
**Question**: What bounds the `webhook-config` stage?
**Options**:
- A: **No timeout** — rely on the `gh` wrapper's default behavior; if it hangs, discovery hangs. Simplest, matches FS-stage semantics ("wait for the OS").
- B: **Bounded timeout with fall-through** — apply a short timeout (e.g. 3–5s) around the `gh api` call; on timeout, log a warn line and fall through to FS stages. Bounded startup latency.
- C: **Fire-and-forget with race** — start the `gh` call and the FS walk concurrently; whichever resolves first wins. Preserves FS-first speed while adding webhook-config as a parallel path.

**Answer**: *Pending*
