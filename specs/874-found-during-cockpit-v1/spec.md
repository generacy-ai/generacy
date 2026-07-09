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

### US1: Cockpit request-changes review reaches the worker on a scaffolded cluster

**As a** cockpit operator who selected request-changes at the implementation-review gate on a freshly-scaffolded cluster running with App credentials,
**I want** the inline review comments posted through the cluster's own bot identity to be recognized as first-party feedback by the #869 `cluster-identity` trust rule,
**So that** the PR-feedback loop actually addresses the changes I asked for instead of stranding the PR behind a permanently-degraded trust predicate.

**Acceptance Criteria**:
- [ ] On a scaffolded cluster with App credentials, a review comment authored by `<app-slug>[bot]` (REST form) or `<app-slug>` (GraphQL form) with `author_association: NONE` on an unresolved thread is classified as trusted with `reason: cluster-identity`, enqueued by the monitor, and processed by `PrFeedbackHandler`.
- [ ] The `cluster-identity` trust rule fires on the exact deployment shape #869 was designed for (scaffolded cluster + App credentials), not only on clusters where a maintainer has hand-populated `GH_USERNAME`.
- [ ] The trust comparison succeeds whether the comment author's login is reported as `<app-slug>[bot]` (REST) or `<app-slug>` (GraphQL); provisioned identity in either form matches an author in either form.

### US2: Degraded identity resolution is diagnosable in-line

**As a** cockpit operator seeing repeated `untrustedCommentSkips` warns on a PR I know the cluster posted comments on,
**I want** each skip warn to carry the resolved cluster-identity value (or `null`) so I can see at a glance whether the trust rule is inert, plus one loud `error` line at process start naming the chain links that failed,
**So that** I can diagnose "identity never provisioned" without having to grep back through the process history or reason about the four-way chain from the skip evidence alone.

**Acceptance Criteria**:
- [ ] Every `untrustedCommentSkips` warn log includes a `clusterIdentity` field carrying either the resolved acting login or `null`.
- [ ] When acting-identity resolution returns nothing at process start, exactly one `error`-level log line is emitted naming every chain link tried and its outcome.
- [ ] The `error` line and the `clusterIdentity: null` skip fields are the two pieces of evidence sufficient to conclude "acting identity is not provisioned" without further log archaeology.

### US3: Acting identity is separately provisioned and does not accidentally key on the assignee

**As a** cluster operator or cloud-deploy owner,
**I want** the acting login (the bot the cluster authenticates as) provisioned at cluster creation as its own concept, distinct from the assignee identity (whose issues the cluster works),
**So that** the trust predicate compares against the right account and setting only the assignee never accidentally trusts the wrong login.

**Acceptance Criteria**:
- [ ] Both the local scaffolder and the cloud-deploy path write the acting login into the orchestrator container's environment (or equivalent runtime channel).
- [ ] The trust predicate's `clusterIdentity` context field is populated from the acting login, not from the assignee-identity chain.
- [ ] A cluster with `CLUSTER_GITHUB_USERNAME` / assignee identity set but acting login unset does not treat comments authored by the assignee login as trusted via `cluster-identity`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Introduce an **acting-identity resolution path** distinct from the #830 assignee chain. Preferred source: derived from the App credential flow the orchestrator already owns (the bot login is `<app-slug>[bot]`, normalized to `<app-slug>`). Fallback source: an explicit env var (name TBD, e.g. `CLUSTER_ACTING_LOGIN`) provisioned by the scaffolder / cloud-deploy. The resolved acting login is what feeds the `cluster-identity` predicate's context field. | P0 | Fixes root cause 1 + 2 (no identity provisioned; assignee ≠ acting). |
| FR-002 | The `cluster-identity` trust predicate **normalizes bot-login format** on both sides of the comparison: an `[bot]` suffix is stripped from the provisioned value and from the observed comment author before equality is checked. Regression fixture: `generacy-ai[bot]` provisioned vs `generacy-ai` observed, and vice versa, both trust. | P0 | Fixes root cause 3 (REST/GraphQL divergence). |
| FR-003 | The **local scaffolder** (`packages/generacy/src/cli/commands/cluster/scaffolder.ts` — `scaffoldEnvFile()` and `scaffoldDockerCompose()`) writes the acting-login env var into the generated `.env` and/or `docker-compose.yml`. If FR-001 uses App-flow derivation, this reduces to threading the app slug through; if it uses explicit provisioning, the scaffolder must accept and write the value. | P0 | Fixes root cause 1 on freshly-scaffolded clusters. |
| FR-004 | The **cloud-deploy path** provisions the same acting-login source as FR-003 by whichever mechanism it uses to mirror scaffolder env/compose. The two paths must not diverge silently. Whichever lands first in this repo, an issue is opened in the other codebase to close the gap; the two are diffed before both close. | P0 | Fixes root cause 1 on cloud clusters; guards the known "scaffolder and cloud-deploy hand-mirror" failure chain. |
| FR-005 | Every `untrustedCommentSkips` warn log entry (per-comment) **includes a `clusterIdentity` field** carrying either the resolved acting login or `null`. This makes the degraded trust-rule mode visible from the skip evidence itself, not from separate log archaeology. | P0 | Fixes root cause 4 (degraded mode not observable from skips). |
| FR-006 | When acting-identity resolution returns nothing at process startup, the orchestrator emits **exactly one `error`-level log line** naming each chain link tried (App-flow derivation source, `CLUSTER_ACTING_LOGIN` / final env var name, any other tried sources) and its outcome (empty, 403, parse-failure, etc.). One line per process lifecycle — no per-poll repeat. | P0 | Fixes root cause 4 (Q4 log unobservable). Complements FR-005 by giving one loud edge event. |
| FR-007 | The acting-identity resolution path **does not fall back to the assignee identity** (the #830 chain). If acting resolution fails, the predicate's `clusterIdentity` context is `null` and the degraded mode kicks in — it does not silently key on the assignee login. | P0 | Fixes root cause 2 (asymmetric fallback would re-conflate the two concepts). |
| FR-008 | #869's FR-002 / FR-003 loud-retention behavior on the zero-trusted path (label retention, `warn` naming skipped authors, no false "No unresolved threads found" line) **continues to hold** in the degraded (identity-unresolvable) mode. Fixing the trust rule does not silently regress the safety net that catches its failure. | P1 | Explicit non-regression of #869 behavior verified live. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cockpit request-changes reaches the worker on scaffolded + App-credential clusters | 100% of request-changes reviews posted via the cockpit on a scaffolded cluster with App credentials result in the worker claiming and processing the feedback within one poll cycle — no `untrustedCommentSkips ... reason: none-untrusted` for the cluster's own bot author | Replay of the christrudelpw/sniplink#4 / PR #14 scenario on a freshly-scaffolded cluster; assert `PR feedback work enqueued` → `PrFeedbackHandler` claim → new commit within one poll cycle; grep the skip warns for cluster-identity-authored comments returns empty. |
| SC-002 | Bot-login format normalization matches both REST and GraphQL | Trust succeeds in all four combinations of `{provisioned with [bot] suffix, provisioned without}` × `{author reported with [bot] suffix, without}` | Unit test on the predicate with all four fixture pairs; assert all four return trusted with `reason: cluster-identity`. |
| SC-003 | Degraded mode is diagnosable from a single log window | Given a cluster with acting-identity resolution failing, an operator reading a single log window containing any `untrustedCommentSkips` warn can determine identity is unresolved without querying prior processes | Regression test: start orchestrator with resolution failing → assert exactly one `error`-level line at startup naming chain links; assert every skip warn carries `clusterIdentity: null`. |
| SC-004 | Acting-identity resolution is a separate code path from the assignee chain | Zero call sites where the trust predicate reads `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / the #830 chain directly to populate `clusterIdentity` | Grep audit in test: assert `resolveClusterIdentity` (or the acting-identity function) is not exported into the trust predicate's context; assert the assignee-chain functions have no callers in the trust module. |
| SC-005 | Scaffolder and cloud-deploy stay in sync on acting-identity provisioning | 0 divergent env-var or compose fields for acting identity between the scaffolder output and the cloud-deploy output | Integration test: run the scaffolder against a fixture project, diff resulting `.env` and `docker-compose.yml` against a cloud-deploy fixture — no unexplained differences in acting-identity vars. (If cloud-deploy lands in a separate repo, this SC is deferred to a cross-repo verification issue and cross-linked.) |
| SC-006 | #869's non-silent retention holds in degraded mode | 0 occurrences of "No unresolved threads found" while `unresolvedThreads > 0` in the degraded-identity path | Existing #869 regression tests re-run with acting-identity resolution disabled; assert the FR-002/003 loud-retention outcomes still hold. |

## Assumptions

- The orchestrator's App credential flow either already exposes the app slug it authenticates as, or can be extended cheaply to do so. If neither is true, FR-001's derived source falls back to the explicit env var and FR-003/FR-004 carry the full weight.
- The `<app-slug>[bot]` login convention is stable enough that stripping/appending `[bot]` is a reliable normalization for the trust comparison. (Corollary: no non-bot user login ever ends in `[bot]` — GitHub reserves the suffix.)
- The scaffolder and cloud-deploy paths are the only two production entry points that provision cluster env vars; internal test rigs may configure the acting login directly. If a third provisioning path exists (e.g., manual container recreation), it must be diffed against FR-003/FR-004 as part of this work.
- The #830 assignee chain (`CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`) stays in place unchanged — this spec adds a sibling chain, it does not modify the existing one.

## Out of Scope

- The #830 assignee-identity chain itself. This spec introduces a sibling concept; the assignee chain's semantics and callers are unchanged.
- Multi-cluster / shared-App-identity setups where more than one cluster authenticates as the same bot. Single-acting-identity assumption; multi-cluster attribution is a follow-up.
- Any change to the shape of the trust predicate itself beyond wiring the new `clusterIdentity` context field and the bot-suffix normalization. #869's `isTrustedCommentAuthor` and its OWNER/MEMBER/COLLABORATOR association branch stay put.
- Cloud-deploy provisioning changes that live in a different repo (generacy-cloud). This repo's spec covers the local-scaffolder and orchestrator sides; the cross-repo companion issue is called out in FR-004 but its implementation is separate.
- Human-user reviewer accounts. This spec addresses the cluster's own bot identity; personal-account and OAuth-token clusters are covered by the existing OWNER/MEMBER/COLLABORATOR branch of the trust predicate and are unchanged here.

---

*Generated by speckit*
