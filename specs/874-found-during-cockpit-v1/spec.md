# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #33

**Branch**: `874-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #33. Follow-up to #869 — its machinery shipped correctly and is verified live; its central trust rule is inert because the identity it compares against is never provisioned.

## Observed (post-#869 cluster, fresh restart)

The operator re-ran `/cockpit:review …#4 --gate implementation-review` and selected request-changes; the cockpit posted inline comments on PR #14. Every poll since:

```
level=40 "PR has unresolved threads but every comment author is untrusted"
  untrustedCommentSkips=[{author:"generacy-ai", authorAssociation:"NONE", reason:"none-untrusted"} ×3]
```

Verified working from #869: shared predicate at the monitor (no enqueue manufactured), per-skip warn evidence, FR-004 top-level notice posted exactly once (marker dedupe held across ~10 polls). Verified broken: the `cluster-identity` trust rule never fires.

## Root causes (layered)

1. **No acting identity is provisioned.** In the orchestrator container, `CLUSTER_GITHUB_USERNAME` and `GH_USERNAME` are both empty, and the chain's tail — `gh api user` — 403s on App installation tokens (the #830 pathology). `resolveClusterIdentity()` therefore returns nothing on exactly the deployment shape it was built for (scaffolded cluster + App credentials), and the predicate's documented degraded mode runs permanently.
2. **Assignee identity ≠ acting identity.** The #830 chain was designed to answer "whose issues do we work" (`christrudelpw` on this cluster). Trust needs "which account authors our own comments" — the App bot (`generacy-ai`). Even a correctly-populated `GH_USERNAME` would carry the *wrong identity* for the trust comparison. These are two concepts; one chain conflates them.
3. **Bot-login format trap (latent).** REST reports App authors as `generacy-ai[bot]`; GraphQL `author.login` reports `generacy-ai`. Whichever value gets provisioned, the predicate must normalize (strip/compare the `[bot]` suffix both ways) or the comparison fails anyway.
4. **The #869 Q4 "prominent identity-resolution failure" log is not observable.** 30 minutes of logs contain the warn skips but no `error`-level identity-resolution-failure line naming the chain links tried. Either it never fires or it fired once pre-window; either way the degraded mode is not diagnosable from the skip evidence itself.

## Proposal

- **New, separate identity: the acting login.** Options, strongest first: (a) derive it — the orchestrator owns the App credential flow and knows what it authenticates as; the bot login is `<app-slug>[bot]` (normalized `<app-slug>`); (b) provision `CLUSTER_ACTING_LOGIN` (name TBD) at cluster creation — the scaffolder knows the App. Keep it distinct from the assignee chain; the trust predicate's `clusterIdentity` context field consumes the acting login, not the assignee.
- **Normalize bot logins in the predicate** — compare with and without the `[bot]` suffix (regression fixture: REST-form provisioned value vs GraphQL-form author).
- **Local scaffolder and cloud-deploy must both write it** — cloud-deploy hand-mirrors the scaffolder's env/compose, and divergence silently breaks cloud clusters (known failure chain); whichever lands first, diff the other.
- **Make the degraded mode visible in-line**: include `clusterIdentity: null` (or the resolved value) in every `untrustedCommentSkips` warn, and emit the Q4 `error` line once per process start when resolution fails.

## Regression tests

- Cluster with acting login provisioned: comment authored by `<acting>[bot]` (REST) or `<acting>` (GraphQL) on an unresolved thread → trusted (`reason: cluster-identity`), enqueue fires, handler proceeds.
- No acting login resolvable → skip warns carry `clusterIdentity: null`; one `error`-level resolution-failure line at startup; FR-002/003 loud retention (already verified live).
- Assignee identity set but acting login unset → trust does NOT accidentally key on the assignee.


## User Stories

### US1: Trust the cluster's own comments on scaffolded clusters

**As an** operator of a freshly-scaffolded local cluster,
**I want** cockpit-authored PR comments to be recognized as coming from the cluster's acting identity,
**So that** the `cluster-identity` trust rule fires and unresolved-thread handling actually proceeds instead of stalling on `none-untrusted` skips.

**Acceptance Criteria**:
- [ ] On a freshly-scaffolded cluster where `CLUSTER_ACTING_LOGIN` is provisioned, a comment authored by `<acting>[bot]` (REST) or `<acting>` (GraphQL) on an unresolved thread is trusted with `reason: cluster-identity`, and the enqueue fires.
- [ ] Assignee identity being set (`CLUSTER_GITHUB_USERNAME` / `GH_USERNAME`) does NOT cause the trust rule to key on the assignee — the acting-identity source is distinct.
- [ ] Bot-login format differences (REST `[bot]` suffix vs GraphQL no-suffix, display-case drift, whitespace in provisioned value) do not defeat the equality check.

### US2: Diagnose the degraded mode from a single log window

**As an** operator investigating why the trust rule is inert,
**I want** every `untrustedCommentSkips` warn to carry the resolved cluster identity (or `null`), plus a single startup `error` line naming the tried chain when resolution fails,
**So that** I can tell whether the trust rule is silently degraded or working from any recent log slice, without needing to reproduce boot logs.

**Acceptance Criteria**:
- [ ] Every `untrustedCommentSkips` warn context includes the resolved `clusterIdentity` value (or `null` when unresolved).
- [ ] When acting-identity resolution returns nothing, exactly one `error`-level log line is emitted at process startup, naming each chain link tried and its outcome.
- [ ] When resolution succeeds via any chain link, no `error` line is emitted for the run.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Introduce a new acting-identity resolution path that is distinct from the #830 assignee chain. Source: env var `CLUSTER_ACTING_LOGIN` written by the scaffolder (and mirrored by cloud-deploy per FR-004). No derivation-from-credential in this PR — see clarifications Q1. | P1 | Q1=A: env var is the sole source. |
| FR-002 | The trust predicate normalizes both sides of the acting-login comparison by: (i) stripping the `[bot]` suffix, (ii) lowercasing, (iii) trimming whitespace. Both sides go through the same pipeline before equality. | P1 | Q3=C: full normalization, defense-in-depth against display-case drift and hand-edited `.env` whitespace. |
| FR-003 | The local scaffolder (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`) writes `CLUSTER_ACTING_LOGIN` into the generated `.env` and threads it through `docker-compose.yml` so the orchestrator container has it in its environment. | P1 | Q2=A: env var name is `CLUSTER_ACTING_LOGIN`, sibling to `CLUSTER_GITHUB_USERNAME`. |
| FR-004 | The cloud-deploy path (in `generacy-cloud`) must provision the same `CLUSTER_ACTING_LOGIN` source. This PR ships standalone against the local scaffolder; a tracking issue is opened in `generacy-cloud` to close the gap, and the two provisioning surfaces are diffed before both close. | P1 | Q5=A: ship standalone, follow-up tracked cross-repo. |
| FR-005 | Every `untrustedCommentSkips` warn context includes the resolved `clusterIdentity` value (or `null` when unresolved). When a skip is emitted, the log line also includes the normalized forms of both sides that were compared. | P1 | Q3=C mitigation: normalized-form logging offsets the auditability cost of aggressive normalization. |
| FR-006 | When acting-identity resolution returns nothing, exactly one `error`-level log line is emitted at process startup, naming each chain link tried and its outcome. Resolution runs synchronously at boot; the resolved (or `null`) value is cached for process lifetime and never re-attempted. The line names exactly what is missing (i.e., `CLUSTER_ACTING_LOGIN` unset). | P1 | Q4=A: synchronous-at-boot, error line iff total failure, cached. |
| FR-007 | The trust predicate MUST NOT fall back to the assignee chain (`CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / `gh api user`) when acting-identity resolution fails. Acting and assignee are distinct concepts (see root cause #2); conflating them would widen trust toward a non-acting account. Degraded mode (no trust rule fires) is the correct outcome. | P1 | Rules out Q5=C compensation. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Trust rule fires on freshly-scaffolded clusters | 100% | Manual + automated test: scaffold cluster with `CLUSTER_ACTING_LOGIN=generacy-ai`, post cockpit comment on unresolved thread, assert `reason: cluster-identity` in trust decision log. |
| SC-002 | Normalization covers the (REST vs GraphQL) × (case drift) × (whitespace drift) matrix | 16 fixture pairs pass | Table-driven unit test in the trust predicate: 4 suffix combinations × 2 case × 2 whitespace = 16 (provisioned, observed) pairs; all normalize to equal. |
| SC-003 | Degraded-mode observability | Every skip carries `clusterIdentity` in context; error line present at boot on unresolved | Log-window inspection: any 10-minute window with at least one skip contains the field in every skip; boot log window contains exactly one `error` line iff resolution returned nothing. |
| SC-004 | No accidental trust widening on unresolved acting-identity | Zero fallbacks to assignee/account chain | Code review + unit test: verify predicate never consults `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / `gh api user` for the acting-identity comparison. |
| SC-005 | Local scaffolder and cloud-deploy provision the same env var | grep-diff parity | Cross-repo verification (deferred to follow-up tracking issue per Q5=A): `grep -R CLUSTER_ACTING_LOGIN` in both repos returns matching provisioning surfaces. |

## Assumptions

- The scaffolder is the correct write site for the acting-login env var (Q1=A rules out derivation-from-credential in this PR; the credential JSON's existing `gitIdentityLogin` may be a cheap derivation candidate for a follow-up, but is not consulted here).
- Existing clusters do NOT gain the env var by container restart alone; the live repro requires `.env`/compose regeneration (or hand-adding the var) after upgrade. Until then, FR-006's error line names exactly what is missing.
- The bot login for an installed GitHub App is well-formed as `<app-slug>[bot]` (REST) / `<app-slug>` (GraphQL); no ambiguity on GitHub's side beyond the case/whitespace surface FR-002 covers.

## Out of Scope

- Derivation of the acting-login from the `github-app` credential JSON at runtime (extend credential schema, plumb through `wizard-env-writer.ts`) — deferred; see Q1 rationale.
- App-JWT-scoped credentials for `gh api /app` runtime resolution — materially larger change; explicitly out of scope.
- Cloud-deploy (`generacy-cloud`) provisioning of `CLUSTER_ACTING_LOGIN` — tracked in a follow-up issue in that repo (Q5=A).
- Backfilling `CLUSTER_ACTING_LOGIN` into already-running clusters via container restart alone — operators must regenerate compose or hand-add the var.
- Broader identity refactor unifying acting vs assignee resolution — trust and workload-assignment remain two chains.

---

*Generated by speckit*
