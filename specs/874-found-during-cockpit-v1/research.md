# Research: acting-identity resolution

## 1. Env var as sole source (Q1=A)

**Decision**: `CLUSTER_ACTING_LOGIN` env var is the only acting-identity source in this PR.

**Rationale**:
- Derivation from the `github-app` credential JSON (option B) requires extending the credential schema and plumbing through `packages/control-plane/src/services/wizard-env-writer.ts`. The credential JSON today carries `installationId`, `token`, `accountLogin`, `gitIdentityLogin` — none of which are the App slug (bot login). Adding an `appSlug` field is blocked on the cloud wizard writing it; local scaffolder-only clusters wouldn't be helped.
- Runtime derivation via `gh api /app` (option D) requires App-JWT credentials, not installation tokens. That's a materially larger change and explicitly out of scope in the spec.
- The "two paths" hybrid (option C) violates one-mechanism-per-job. If derivation ever proves valuable, it's a compatible follow-up: add derivation, keep the env var as fallback.
- The scaffolder writes the value automation-side, so the #847 "config nobody writes" trap does not apply.

**Follow-up worth doing after this ships**: check whether the credential JSON's existing `gitIdentityLogin` field can safely carry the bot login (cheap derivation candidate). Not in scope here.

**Alternatives considered**: B (schema-extension + wizard-env-writer plumbing), C (both), D (App-JWT credentials). All rejected in Q1.

## 2. Full normalization pipeline (Q3=C)

**Decision**: Strip `[bot]` suffix + lowercase + trim whitespace. Applied to both sides of the equality comparison.

**Rationale**:
- The asymmetry between under- and over-normalization decides it:
  - Under-normalization silently reproduces the whole bug class — trust rule inert on any case- or whitespace-drift. This is the *worst* outcome because it's exactly the failure mode this PR exists to fix.
  - Over-normalization cannot mis-trust a **different** account: GitHub logins are case-insensitive at the identity layer (`Generacy-AI` and `generacy-ai` are the same account); trailing whitespace and the `[bot]` suffix are not valid parts of a distinct login.
- Delegate-to-scaffolder (option D) can't defend against hand-edited `.env` values, which is a real local-cluster path.
- Auditability cost mitigated by FR-005: skip warns log both raw and normalized forms, so operators can trace equality decisions back to input.

**References**:
- GitHub docs: [Personal accounts and organizations — usernames](https://docs.github.com/en/get-started/learning-about-github/github-glossary#login) — login rules render the display form; identity is case-insensitive.
- GraphQL `author.login` vs REST `user.login`: REST reports App authors as `<slug>[bot]`; GraphQL reports `<slug>`. Confirmed in the live #874 sniplink.

**Alternatives considered**: strip-only (A), strip+lowercase (B), delegate-to-scaffolder (D).

## 3. Synchronous-at-boot resolution with lifetime cache (Q4=A)

**Decision**: Resolve `CLUSTER_ACTING_LOGIN` synchronously during `createServer()`. Cache the result (value or `undefined`) for the process lifetime. Emit exactly one `error`-level log iff resolution returned nothing.

**Rationale**:
- With Q1=A the source is a process env var. Env vars can't transiently fail or change mid-process, so:
  - Option D's retry machinery has no failure mode to handle.
  - Option C's lazy timing (defer to first predicate call) buys nothing — the error line still lands eventually, and no user-facing symptom improves.
- Option B (log every failed link even if some other link succeeded) has no meaning when there's only one link. This is a Q1=A downstream simplification.
- US2's "diagnose from a single log window" acceptance is carried by the per-skip `clusterIdentity: null` context (FR-005), not by the boot line's position in the log. The boot line is a supplementary signal.

**Alternatives considered**: B (log all failed links), C (lazy), D (retry).

## 4. Ship standalone; cloud-deploy tracked cross-repo (Q5=A)

**Decision**: This PR lands the local scaffolder + orchestrator + workflow-engine changes. A tracking issue in `generacy-cloud` covers cloud-side `LaunchConfig` provisioning.

**Rationale**:
- Matches the established cross-repo rule ("one self-contained issue per repo; cloud-deploy hand-mirrors the scaffolder and must be diffed against it").
- Option B (block on generacy-cloud first) couples the repos and delays the fix for local clusters, which is the shape of the live repro.
- Option C (temporary runtime compensating source in the orchestrator) violates FR-007 (no fallback to the assignee/account chain) — the compensating source would necessarily widen trust toward a non-acting account.
- Option D (downscope FR-004 entirely) drops cloud-deploy from the spec and would silently break cloud clusters.

## 5. FR-mapping: FRs → code changes

| FR | Location | Change kind |
|----|----------|-------------|
| FR-001 | `packages/orchestrator/src/services/acting-identity.ts` | Add |
| FR-002 | `packages/workflow-engine/src/security/comment-trust.ts` `normalizeLogin` helper + apply at line 87 and line 94 | Add + modify |
| FR-003 | `packages/generacy/src/cli/commands/cluster/scaffolder.ts` `scaffoldEnvFile` — new optional `actingLogin` input field, one line emitted | Modify |
| FR-004 | Cross-repo issue in `generacy-cloud`; grep-diff SC-005 verification | Follow-up (out of this PR's diff) |
| FR-005 | `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:285` warn ctx; `packages/orchestrator/src/worker/pr-feedback-handler.ts:210` info + `:263` warn ctx | Modify |
| FR-006 | `packages/orchestrator/src/services/acting-identity.ts` — `logger.error({ triedChain: ['CLUSTER_ACTING_LOGIN'] }, …)` when env unset. `packages/orchestrator/src/worker/pr-feedback-handler.ts:125` — update `triedChain` naming to the new chain | Add + modify |
| FR-007 | Enforced by design — new resolver never consults `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / `gh api /user`. Assignee chain stays in `resolveClusterIdentity()` for `filterByAssignee` only. Unit test asserts. | Test |

## 6. FR-005 skip-warn shape decision: raw + normalized both sides

Given Q3=C's aggressive normalization, the audit trail becomes: "was the equality decision correct?" To make that answerable from a log line without cross-referencing code, every skip logs:

```
{
  commentId: number,
  author: string,              // raw
  normalizedAuthor: string,    // after normalizeLogin
  authorAssociation: string,
  reason: string,
  clusterIdentity: string | null,     // raw provisioned value, null if unresolved
  normalizedClusterIdentity: string | null,  // after normalizeLogin, null if unresolved
}
```

An operator scanning a log window can immediately verify: (a) whether `normalizedAuthor === normalizedClusterIdentity` should have matched but didn't (bug!), and (b) what raw pair produced the mismatch.

## 7. Sources / references

- Spec: `specs/874-found-during-cockpit-v1/spec.md`.
- Clarifications: `specs/874-found-during-cockpit-v1/clarifications.md`.
- Predecessor: `#869` (introduced the `cluster-identity` trust rule; verified live). See CLAUDE.md `## Pause-Paired Resume-Dedupe Clear (#849)` section for #869's #849 sibling context.
- Assignee chain: `packages/orchestrator/src/services/identity.ts` `resolveClusterIdentity()` (#830). Retained.
- Trust predicate matrix: `packages/workflow-engine/src/security/comment-trust.ts` decision order (#842).
- Live sniplink from spec: post-#869 cluster, fresh restart, poll produces `untrustedCommentSkips=[{author:"generacy-ai", authorAssociation:"NONE", reason:"none-untrusted"} ×3]`.
