# Implementation Plan: Author-trust gating for workflow-ingested GitHub comments

**Feature**: Author-trust gating for workflow-ingested GitHub comments
**Branch**: `842-motivated-live-incident-during`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md) | **Clarifications**: [clarifications.md](./clarifications.md)
**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)

## Summary

Three ingestion surfaces (`clarification-poster.ts` answer-scanner, `clarify.ts` resume prompt, `read-pr-feedback.ts` reader) currently trust every human-authored GitHub comment on an issue/PR. On public repos this is a live prompt-injection / supply-chain vector against autonomous workers.

This change threads GitHub's `author_association` field from the `gh` REST projections all the way to a single new trust helper (`isTrustedCommentAuthor`) shared by all three surfaces. Default-trusted tiers are `OWNER`, `MEMBER`, `COLLABORATOR`, plus the cluster's own bot identity (resolved via the existing `identity.ts` chain, per #830 — no new env var). `CONTRIBUTOR` is untrusted by default; unset / unrecognized tiers fail closed with a `warn` log. An optional workspace-level `.agency/comment-trust.yaml` can widen the allowlist for **context** surfaces only — the clarify answer-scanner is pinned to the hard default because it deterministically writes into the spec. When the answer-scanner drops a comment that matched the `Q<N>:` pattern, a single bot comment on the issue explains the drop (metadata only). All phase prompts that embed thread content wrap it in an explicit `<untrusted-data>` fence.

## Technical Context

**Language/Version**: TypeScript (Node.js >=22, ESM)
**Primary Dependencies**: `@generacy-ai/workflow-engine`, `@generacy-ai/orchestrator`, `@generacy-ai/config`, `zod`, `yaml`
**Storage**: None (workspace-level YAML config file at `.agency/comment-trust.yaml`)
**Testing**: `vitest` — unit tests for trust helper (table-driven), integration tests for each surface (fixture-based), prompt-template audit tests
**Target Platform**: Linux (cluster containers) + local dev
**Project Type**: Monorepo — `packages/workflow-engine`, `packages/orchestrator`, `packages/config`
**Performance Goals**: No user-visible latency change; per-comment filter is a synchronous string check
**Constraints**: Fail closed on unknown / unset `author_association`; never emit comment bodies to logs; must not break existing fixtures (nullable `authorAssociation` field)
**Scale/Scope**: 3 ingestion call sites, 1 new helper, 1 new config schema, ~2 modified `gh` projections, 1 new `Comment` field, N prompt templates audited

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — no additional gates apply beyond the spec's Functional Requirements and Success Criteria.

**Self-imposed gates from the spec**:

- **Single source of truth** (FR-003, SC-002): All three surfaces MUST go through the same helper. Grep audit for `getIssueComments` / `getPRComments` / `--comments` MUST show each call site adjacent to an `isTrustedCommentAuthor` call.
- **Fail closed** (FR-011, SC-008): Any tier not in the trusted allowlist AND not in the known untrusted enumeration → untrusted + `warn` log naming the tier.
- **No body in logs** (US2 AC, SC-003): Only metadata (id, author, tier, surface, reason). Unit tests assert absence of body substring in captured log records.
- **Answer-scanner pinned** (Q4/FR-008): The config-widen path MUST NOT reach the answer-scanner. Table-driven test asserts a `CONTRIBUTOR` widen entry trusts on context surfaces and rejects on the scanner.
- **Bot identity via `identity.ts` chain** (Q1/FR-012): Do NOT introduce `GENERACY_BOT_LOGIN`. Reuse `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → memoized `gh api /user`. Warn (don't fail) if the chain resolves nothing.
- **Config cannot narrow defaults** (US3 AC, FR-008): Widen-only. `OWNER`/`MEMBER`/`COLLABORATOR` cannot be removed via config.

## Project Structure

### Documentation (this feature)

```text
specs/842-motivated-live-incident-during/
├── spec.md                # Feature specification (read-only)
├── clarifications.md      # 5-question clarify batch (read-only)
├── plan.md                # This file
├── research.md            # Decisions + alternatives considered
├── data-model.md          # Type extensions, config schema, trust decision
├── quickstart.md          # How to enable, how to widen, how to audit
├── contracts/
│   ├── comment-trust-config.schema.json    # .agency/comment-trust.yaml Zod-derived schema
│   └── trust-helper.contract.md            # isTrustedCommentAuthor input/output contract
└── tasks.md               # Phase 2 output (/speckit:tasks — NOT this file)
```

### Source Code (repository root)

Only surfaces touched by this change are listed. All other files unchanged.

```text
packages/workflow-engine/src/
├── types/
│   └── github.ts                                          # MODIFIED: Comment.authorAssociation?: string
├── actions/github/client/
│   └── gh-cli.ts                                          # MODIFIED: getIssueComments + getPRComments emit author_association
├── actions/github/
│   └── read-pr-feedback.ts                                # MODIFIED: partitions into { trustedComments, skippedComments }
├── security/                                              # NEW dir
│   ├── comment-trust.ts                                   # NEW: isTrustedCommentAuthor() + tier enums
│   ├── comment-trust-config.ts                            # NEW: Zod schema + tryLoadCommentTrustConfig()
│   ├── untrusted-data-fence.ts                            # NEW: wrapUntrustedData(content, sourceLabel)
│   └── __tests__/
│       ├── comment-trust.test.ts                          # NEW: table-driven trust matrix
│       ├── comment-trust-config.test.ts                   # NEW: config loader + widen rules
│       └── untrusted-data-fence.test.ts                   # NEW: fence formatting
└── actions/builtin/speckit/operations/
    └── clarify.ts                                         # MODIFIED: buildResumePrompt takes pre-filtered comments, drops raw `gh issue view --comments`

packages/orchestrator/src/
├── worker/
│   ├── clarification-poster.ts                            # MODIFIED: filters via isTrustedCommentAuthor before parseAnswersFromComments; posts explainer bot comment on Q<N>: skips
│   └── pr-feedback-handler.ts                             # MODIFIED: logs skipped-per-surface for the pr-feedback surface
└── services/
    └── identity.ts                                        # (unchanged — reused for bot login resolution)

packages/orchestrator/src/worker/__tests__/
├── clarification-poster-trust.test.ts                     # NEW: integration test for FR-004 + FR-013 (bot-explainer comment)
└── pr-feedback-trust.test.ts                              # NEW: integration test for FR-006
```

**Structure Decision**: Shared trust logic lives in `packages/workflow-engine/src/security/` (new dir) rather than in `packages/orchestrator` because two of the three call sites (`read-pr-feedback.ts` and `clarify.ts`) are in workflow-engine, and workflow-engine cannot depend on orchestrator. Orchestrator's `clarification-poster.ts` imports from workflow-engine (already a runtime dep). Bot identity resolution stays in `packages/orchestrator/src/services/identity.ts` (already a shared cluster concept, re-exported via the orchestrator public API and passed into the trust helper as a resolved value, not a callback — the helper stays pure).

**Config file location**: `.agency/comment-trust.yaml` (workspace-relative, sibling to `credentials.yaml`). Loader lives in `packages/workflow-engine/src/security/comment-trust-config.ts`. Missing / malformed file → default posture (no throw). Existing `.agency/` directory conventions are honored (path is workspace root; orchestrator resolves `workspaceDir` and passes it to workflow-engine actions).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Two config-widen visibility rules (context surfaces widen; scanner pinned) | Clarify answer-scanner deterministically writes into `spec.md` via parsed `Q<N>:` — widening its trust surface = letting outsiders steer the build. Context surfaces are advisory. | A single uniform allowlist (Q4/A) would either (a) force teams that widen for PR-context to also widen for spec-write, or (b) force teams that need spec-write pinning to lose context-widen for legitimate contributors. Split is the smallest ruleset that serves both. |
| Bot-explainer comment on `Q<N>:` skips (FR-013) but not on generic skips | The failure mode presents to the repo owner as "the workflow ignored my visible GitHub answers" — the confusion lives on GitHub, so the explanation must too. Context-surface skips are invisible to the reader (they just don't appear in a prompt), so cluster logs are sufficient. | A blanket bot comment per skip (option C without narrowing) would spam issues on public repos with drive-by comments. Structured-logs-only for scanner skips (option A) hides the failure mode from the repo owner. |
| Nullable `Comment.authorAssociation` field | Fixture / cache / older gh-response compatibility. Existing tests seed `Comment` records without the new field; FR-011 explicitly treats unset as untrusted (fail closed), so nullability is safe. | Making it required would break every existing fixture and force a coordinated update — cost without safety benefit given FR-011's fail-closed rule already handles the field-missing case. |
