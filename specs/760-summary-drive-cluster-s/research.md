# Research: Drive cluster GitHub identity from acting account

**Feature**: 760 — `gitIdentityLogin` consumer half
**Date**: 2026-06-05

All four open questions for this feature were resolved during the `/clarify` phase. This document captures each decision, its rationale, and the alternatives rejected. Source: [`clarifications.md`](./clarifications.md).

## D1 — Defer FR-006 (org-pattern warning)

**Decision**: Do not implement FR-006 in this PR.

**Rationale**:
- The new `gitIdentityLogin` field fixes the root cause (org login used as identity). The org-as-identity case becomes rare once the producer ships.
- Detecting "User" vs "Organization" from a login string is non-trivial: GitHub doesn't expose the kind from the login alone. Options are an extra `gh api /users/<login>` round-trip (Option B) or an unconditional warning at fallback (Option C).
- Option C false-positives on every legitimate user-account install where `accountLogin` IS the correct identity — that's the majority of clusters today.
- Option B adds real complexity (network call, error handling, caching) for a P3.
- The genuinely useful variant ("warn when the resolved identity matches no open-issue assignee over the first N polls") overlaps with the cluster-side backstop in #762 and belongs there.

**Alternatives rejected**: Option B (lazy `/users/<login>` detection — too much complexity for a P3); Option C (unconditional warning at fallback — false-positive storm on user installs).

**Reference**: clarifications.md Q1/A.

## D2 — `gitIdentityLogin` at top level of github-app credential JSON

**Decision**: The producer (generacy-cloud#812) seals `gitIdentityLogin` at the **top level** of the github-app credential JSON, alongside `token` and `accountLogin`. The consumer extracts via `parsed.gitIdentityLogin`.

**Rationale**:
- Consistent with the existing flat shape `{ ...installationData, token, expiresAt, accountLogin }` that the cloud's credential-refresh path already emits (#592, #628).
- `accountLogin` is still needed by the producer (for non-identity uses) and must continue to be emitted. So "replace `accountLogin` entirely" (Option C) is wrong — both fields must coexist.
- Nesting under an `identity: { login: ... }` sub-object (Option B) is needless divergence from the existing flat shape; pattern-match cost on the consumer side increases for zero benefit.

**Alternatives rejected**: Option B (nested under `identity:` sub-object — needless shape divergence); Option C (single dual-semantic field replacing `accountLogin` — wrong because `accountLogin` is still needed elsewhere).

**Reference**: clarifications.md Q2/A.

## D3 — Trim, treat empty/whitespace `gitIdentityLogin` as missing

**Decision**: Apply `.trim()` to `gitIdentityLogin` first. When the trimmed value is non-empty, use it. When it's missing, not a string, empty, or whitespace-only after trim, fall back to `accountLogin` (using the existing `accountLogin` trim-and-length-check).

Effective logic:
```ts
const login =
  (typeof parsed.gitIdentityLogin === 'string' && parsed.gitIdentityLogin.trim().length > 0
    ? parsed.gitIdentityLogin.trim()
    : undefined)
  ?? (typeof parsed.accountLogin === 'string' && parsed.accountLogin.trim().length > 0
    ? parsed.accountLogin.trim()
    : undefined);
```

**Rationale**:
- Mirrors the existing `accountLogin` `length > 0` handling — consistency reduces surprise.
- Trimming matters: a stray space would silently break `git config user.name` (commit attribution) AND the label-monitor assignee filter (which does exact-string `.includes()` against `assignees[]`). Both failure modes are subtle and hard to diagnose.
- Option B (treat empty as a sealed explicit "no identity" → emit nothing + warning) penalizes the user for what's almost always producer-side dirty data, and produces a "what now?" failure mode.

**Alternatives rejected**: Option A (treat empty as missing but don't trim — too permissive, whitespace leaks through); Option B (treat empty as explicit, force re-seal — penalizes user for producer dirty data).

**Reference**: clarifications.md Q3/A.

## D4 — Preserve `identity.ts` resolution order

**Decision**: `CLUSTER_GITHUB_USERNAME` (`configUsername`) continues to win over `GH_USERNAME` in `resolveClusterIdentity`. No logic change to `identity.ts`; comment correction only.

**Rationale**:
- `CLUSTER_GITHUB_USERNAME` is the documented manual escape hatch. An operator setting it deliberately should win over any field flowing through the cloud-side picker.
- Making `gitIdentityLogin` override the env var would defeat the purpose of an escape hatch and create an unfixable failure mode if the cloud-sealed value is wrong (operator's only option to fix it would be to re-run activation).
- This is the lowest-risk choice — no behavior change for clusters that have set `CLUSTER_GITHUB_USERNAME`.

**Alternatives rejected**: Option B (cloud picker overrides env var — removes the escape hatch, creates unfixable failure modes).

**Reference**: clarifications.md Q4/A.

## Implementation Patterns

- **Trim-before-length-check**: Follows existing `accountLogin` handling style; minimizes diff surface and learning cost.
- **`typeof === 'string'` guard**: Defensive parse for `unknown`-typed JSON.parse output; matches the existing `parsed.token` / `parsed.accountLogin` guard pattern in `mapCredentialToEnvEntries`.
- **No new dependency**: All needed primitives are in the standard library + existing imports.
- **No new exports**: The change is internal to `mapCredentialToEnvEntries`. Test suite extends in place; no new module surface.

## Key References

- `clarifications.md` — Q1–Q4 resolutions.
- `packages/control-plane/src/services/wizard-env-writer.ts:39-67` — `mapCredentialToEnvEntries` function (modification site).
- `packages/orchestrator/src/services/identity.ts:48-55` — `GH_USERNAME` comment (correction site).
- `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` — existing test suite to extend.
- Generacy-cloud companion: #812 (producer of `gitIdentityLogin`).
- Related: #756 (root-cause issue), #762 (cluster-side backstop where FR-006 variant lands).
- Historical context: #592 (top-level `accountLogin` introduced), #628 (`accountLogin` → `GH_USERNAME` / `GH_EMAIL` derivation introduced).
