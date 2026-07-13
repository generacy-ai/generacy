# Research: `viewerDidAuthor` for self-authored comment trust

## Decision 1 — GraphQL `viewerDidAuthor` as the self-recognition primitive

**Chosen**: `viewerDidAuthor: Boolean` on `PullRequestReviewComment` (part of `getPRReviewThreads`).

**Rationale**: The property the trust predicate wants is *"was this comment authored by the credential this cluster operates with?"*. GitHub answers this authoritatively via `viewerDidAuthor`, keyed on the authenticated App identity (stable across hourly installation-token rotation). The current mechanism approximates the property via login-string comparison after a normalization pipeline, which:

- requires a per-cluster env var (`CLUSTER_ACTING_LOGIN`) threaded through the scaffolder, cloud-deploy, and wizard-env-writer — three provisioning surfaces, each a silent-miss risk (as #877 proved);
- requires a `[bot]`-strip / lowercase / trim pipeline with 16 fixture pairs to survive REST vs. GraphQL rendering drift;
- fails silently when the operator scaffolds under a different App account (the #874 finding) or when the provisioning surface skips the write (the #877 finding).

**Alternatives considered**:

- **A: Continue login comparison, harden provisioning surfaces**. Rejected — this smoke test keeps finding that the mechanism itself is the failure mode. Every hardening pass leaves one more provisioning surface that can silently miss.
- **B: Store the App bot identity in a control-plane credential instead of an env var**. Rejected — same shape, different persistence tier. Still a proxy, still misprovision-able.
- **C: `viewerDidAuthor` (chosen)**. Direct answer to the actual question. Zero configuration. Stable across token rotation. Immune to login-format drift.
- **D: Compare the comment's `author.databaseId` against the App's numeric id (queried once at boot)**. Semantically equivalent to C but requires an extra boot-time query and caching the App id. C is strictly simpler.

**Sources**:
- GitHub GraphQL API — `PullRequestReviewComment.viewerDidAuthor: Boolean!` (https://docs.github.com/en/graphql/reference/objects#pullrequestreviewcomment).
- `#869` — original `cluster-identity` trust rule; the property being approximated.
- `#874` — `CLUSTER_ACTING_LOGIN` mechanism (scaffolder writer + normalization pipeline).
- `#877` — wizard-env-writer credential mirror; the silent-miss failure that motivated this rethink.

## Decision 2 — Behavior when `viewerDidAuthor` is missing / `null` / non-boolean

**Chosen** (Q3→D): treat non-`true` values as *not* self-authored, and emit a per-comment `warn` log carrying the comment id and observed value.

**Rationale**:
- Never widen trust on shape drift (rules out `true` default).
- Never stall the poll loop on a GitHub schema hiccup (rules out throw / error / requeue).
- Never eat drift silently (rules out plain `false` default without observability).
- Matches #874's Q4 shape: degrade safely, but loudly.

**Alternatives**: A (silent `false`), B (throw / requeue), C (silent `true`) — see clarifications.md Q3.

## Decision 3 — `TrustReason` union: hard rename vs. dual-emit

**Chosen** (Q1→D): hard rename `'cluster-identity'` → `'self-authored'` with a one-line breaking-change note in the changeset.

**Rationale**: The `'cluster-identity'` string is two days old and has only ever shipped on the preview channel. Dual-emit (B) is machinery for consumers that don't exist. Retaining the old name as an inaccurate label (C) is exactly the anti-pattern this smoke test keeps finding. Hard rename is cheapest and honest; the changeset note is free.

## Decision 4 — Operator-facing cleanup for stale `CLUSTER_ACTING_LOGIN` lines

**Chosen** (Q4→B): one changelog line noting the var is unused and safe to remove. No startup compat log line. No auto-edit of operator files.

**Rationale**: Per #877's finding, most provisioning surfaces *failed* to write the var, so the population of clusters carrying a stale line is approximately the one hand-edited test cluster. A startup compat log is permanent code servicing an almost-empty set; auto-editing operator files (D) is risk with no payoff.

## Decision 5 — PR shape

**Chosen** (Q5→D): single atomic PR — (i) add `viewerDidAuthor` to the query, (ii) replace the predicate, (iii) delete `CLUSTER_ACTING_LOGIN` code across `identity.ts` + scaffolder + docs, (iv) update skip-warn evidence. Atomic keeps `develop` from ever holding a half-state, and lets the SC-003 grep-audit run at merge.

**Rationale**: The additive-then-subtractive alternative (B) briefly requires the union to hold both reason strings — the exact machinery-for-hypothetical-consumers pattern rejected in Q1. The revert-then-replace alternative (C) deliberately re-opens the #869 deadlock in the window between PRs.

**#877 coordination**: #877 has already been retitled and rescoped to its trailing-newline fix; not ordered against this PR.

## Decision 6 — Grep-audit gate for non-thread-shaped self-recognition consumers

**Chosen** (Q2→D verify, B remedy): run the grep-audit before implementation. Expected result: absent. If a consumer is discovered, migrate it to the thread-shaped GraphQL client (B), do not halt (rejects Q2→D).

**Rationale**: #869 introduced `clusterIdentity` only into the shared predicate; its two populate sites (monitor + handler) are both on the thread-shaped client post-#861. Assumption 1 in the spec is that the audit will come back clean. If a straggler exists, the spec's scope-boundary language already prescribes the remedy — there's nothing left to decide at a checkpoint.

**Alternative rejected**: silently downgrading the discovered surface to association-tier only (Q2→C). Silent trust downgrade is how this class of bug starts.

## Implementation patterns

- **GraphQL query extension**: mirror the existing `authorAssociation` addition pattern in `getPRReviewThreads` — add one field to the query, one field to the parsed-response type, one conditional assignment inside the node-map loop (`if (c.viewerDidAuthor !== null && c.viewerDidAuthor !== undefined) comment.viewerDidAuthor = c.viewerDidAuthor;`).
- **Predicate rewrite**: replace decision 1.5 in place. Do not introduce a `viewerDidAuthor` context field on `CommentTrustContext` — the field lives on the comment itself.
- **Test refactor**: delete the 16 `normalizeLogin` positive fixture pairs and the T1–T6 cluster-identity tests. Add: (a) `viewerDidAuthor: true` → trusted; (b) `viewerDidAuthor: false` → falls through; (c) `viewerDidAuthor: null | undefined` → falls through **and** warn logged.
- **Scaffolder deletion**: mirror the addition path — remove the field from `ScaffoldEnvInput`, the interpolation block, and the schema. Do not leave a deprecated marker; the changelog carries the signal.

## Key sources

- Spec: `specs/878-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/878-found-during-cockpit-v1/clarifications.md`
- Predecessor plan: `specs/874-found-during-cockpit-v1/plan.md` (what this supersedes)
- #861 — thread-shaped `getPRReviewThreads` (the client that already reads review threads and where the new field lands)
- #869 — original `cluster-identity` trust rule (the semantic being replaced)
- GitHub GraphQL docs — `PullRequestReviewComment.viewerDidAuthor`

---

*Generated by speckit*
