# Clarifications

## Batch 1 — 2026-07-10

### Q1: viewerDidAuthor warn scope
**Context**: FR-004 explicitly defers this decision to `/clarify`. `comment-trust.ts:111` currently emits a warn when `viewerDidAuthor !== false && !== true` (i.e. field absent), scoped to the `pr-feedback` surface (from #878). The migrated `answer-scanner` and `clarify-resume` surfaces will fetch via GraphQL with the field structurally required. If the warn is extended to them, an absent field on those surfaces becomes an alarm (defect signal). If it stays scoped to `pr-feedback`, a silently-broken GraphQL migration on the new surfaces produces no warn — the same class of bug this feature fixes.
**Question**: Should the "viewerDidAuthor absent" warn in `comment-trust.ts` extend to the `answer-scanner` and `clarify-resume` surfaces?
**Options**:
- A: Extend the warn to both new surfaces. `viewerDidAuthor` is structurally required on the migrated fetch paths; absence is a defect and should be visible.
- B: Keep the warn scoped to `pr-feedback` only. Preserve #878's by-design-absence carve-out; add a code comment on the new surfaces documenting the expectation.
- C: Extend the warn to both new surfaces, but downgrade to `debug`/`info` level on those surfaces to avoid noise on legacy REST-shaped fixtures still in the test suite.

**Answer**: *Pending*

### Q2: getIssueComments API shape
**Context**: FR-001 says "Extend `getIssueComments()` (or add a sibling client method)". The choice affects unrelated callers (`epic/update-status.ts`, `workflow/update-stage.ts` per FR-008) that don't self-trust-evaluate. Mutating the existing method means every caller pays the extra GraphQL cost (one call per fetch); adding a sibling method (e.g. `getIssueCommentsWithViewerAuth()`) leaves unrelated callers unchanged but doubles the surface area of the client and risks future callers picking the wrong one.
**Question**: Should the `viewerDidAuthor` upgrade mutate the existing `getIssueComments()` (single method, universal cost) or add a sibling method that the answer-scanner and clarify-resume call explicitly?
**Options**:
- A: Sibling method (e.g. `getIssueCommentsWithViewerAuth()`). Answer-scanner and clarify-resume migrate; REST-based `getIssueComments()` stays for unrelated callers. Mirrors #878's separate `getPRReviewThreads()`.
- B: Mutate `getIssueComments()` to always populate `viewerDidAuthor` via GraphQL. All callers pay one extra call per fetch; caller code is simpler and there's no "wrong client method" trap.
- C: Add an opt-in flag/option on `getIssueComments()` (e.g. `{ includeViewerAuth: true }`) — single method, opt-in cost, no sibling to confuse future callers.

**Answer**: *Pending*

### Q3: FR-007 dependency enforcement
**Context**: FR-007 says "Do NOT flip trust semantics without #51 (question-marker exclusion) already merged. If #51 is not merged when this feature lands, block on it". The mechanism of "blocking" is left implicit — it could be a merge-order convention enforced by the reviewer, a CI/PR check, or a runtime guard that fails closed if `isQuestionComment()` isn't present. Different mechanisms produce different failure modes if the ordering slips.
**Question**: How should the #51 dependency be enforced at merge time?
**Options**:
- A: Merge-order convention only. PR description references #51 as a blocker; reviewer verifies #51 is merged before approving. No code-level check.
- B: PR-level check. This PR's tasks include verifying `isQuestionComment()` exists and is called before answer parsing on the migrated fetch path; if the function is absent the implement phase fails. No runtime guard.
- C: Runtime guard. On the answer-scanner surface, refuse to run (log + skip) if `isQuestionComment` is not present in the module — fails closed even if #51 is reverted post-merge.

**Answer**: *Pending*

### Q4: GraphQL fetch failure behavior
**Context**: Not addressed by the spec. The migrated fetch paths add a GraphQL call per gate check. On transient GraphQL failure (network, rate limit, schema error) the answer-scanner has three plausible responses: fall back to REST (loses `viewerDidAuthor`, back to the pre-fix broken state, invisible to the operator); fail closed (no comments trusted this cycle, operator sees the pause continue); fail loud (surface an error, potentially escalate to `agent:error`). This matters because a silent REST fallback recreates the exact defect this feature fixes.
**Question**: On transient GraphQL failure while fetching issue comments on the migrated surfaces, what should the answer-scanner (and clarify-resume) do?
**Options**:
- A: Fail closed. No comments treated as trusted this cycle; log a warn with the GraphQL error; gate stays paused until the next successful fetch. Never silently downgrades to REST.
- B: Retry once, then fail closed. Same as A but with a single retry against GraphQL to absorb transient blips.
- C: Fall back to REST with a loud warn. Preserves availability at the cost of temporarily reintroducing the defect; warn flags the degradation so operators can react.

**Answer**: *Pending*

### Q5: FR-008 audit outcome — expand-or-spin-out
**Context**: FR-008 requires a grep-audit for other `getIssueComments()` callers that pass through `isTrustedCommentAuthor`. Expected callers (`epic/update-status.ts`, `workflow/update-stage.ts`) don't self-trust-evaluate. If the audit surfaces a fourth or fifth surface that DOES self-trust-evaluate, the fix's PR scope isn't defined: do we migrate all such surfaces in this PR (broader blast radius, more test fixtures), or land the two named surfaces only and spin out follow-ups?
**Question**: If the FR-008 grep-audit surfaces additional callers that self-trust-evaluate, how should they be handled in this PR?
**Options**:
- A: Migrate in this PR. Keeps the "defect class" fix atomic; matches FR-009's "single atomic PR" framing.
- B: Spin out per-surface follow-up issues. This PR ships only the two named surfaces (answer-scanner + clarify-resume) plus the client-method upgrade; additional surfaces get tracked and shipped separately with their own regression fixtures.
- C: Case-by-case — if the newly-discovered surface is on a hot path (frequently hit like the clarification gate), migrate here; otherwise spin out. Decision documented on the PR.

**Answer**: *Pending*
