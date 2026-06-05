# Clarifications

## Batch 1 — 2026-06-05

### Q1: FR-006 Defense-in-Depth Warning Scope
**Context**: FR-006 proposes that `identity.ts` log an "actionable warning" when the resolved identity "matches a known-org pattern and no other identity sources are available," as a fallback diagnostic for misconfigured org clusters. It is marked **Optional / P3**, but Out-of-Scope does not list it. The implementer needs to know whether this is in scope for this PR — and if so, what defines "known-org pattern" (GitHub does not expose `User` vs `Organization` from a login string alone; detection requires either a `gh api /users/<login>` call or a heuristic).
**Question**: Should FR-006 be implemented in this PR? If yes, what detection mechanism is acceptable?
**Options**:
- A: Defer FR-006 entirely — out of scope for this PR, file a follow-up issue if needed.
- B: Include FR-006, detect org via a runtime `gh api /users/<login>` call when assignee filtering produces zero matches over N issues (lazy detection, no startup cost).
- C: Include FR-006, log the warning unconditionally at startup whenever `GH_USERNAME` was sourced from `accountLogin` fallback (no GitHub API call, simpler but noisier).

**Answer**: **A** — Defer FR-006 entirely. Keep this PR focused on consuming `gitIdentityLogin`; the new field fixes the root cause so the org-as-identity case becomes rare. Option C would false-positive on every legitimate user-account install (where `accountLogin` IS the correct identity); option B adds real complexity for a P3. The genuinely useful version ("warn when the resolved identity matches no open-issue assignee") overlaps with the cluster-side backstop in #762 and should be folded there as a follow-up.

### Q2: `gitIdentityLogin` Field Location in Credential JSON
**Context**: `wizard-env-writer.ts:46` currently parses the github-app credential value as `JSON.parse(value)` and extracts `parsed.token` and `parsed.accountLogin` from the **top level** of the object (per #592, #628). The spec assumes `gitIdentityLogin` is added by the producer (generacy-cloud companion #812) but does not state where in the JSON it lives. This affects the consumer-side parser shape.
**Question**: Where does the producer-side companion seal `gitIdentityLogin` in the github-app credential JSON?
**Options**:
- A: Top-level, alongside `token` and `accountLogin` (e.g. `{ token, accountLogin, gitIdentityLogin, ... }`) — extract via `parsed.gitIdentityLogin`.
- B: Nested under an identity sub-object (e.g. `{ token, accountLogin, identity: { login: ..., ... } }`) — extract via `parsed.identity?.login`.
- C: Replaces `accountLogin` entirely when set (single field, dual semantics) — extract `gitIdentityLogin ?? accountLogin` from one position.

**Answer**: **A** — Top-level, alongside `token` and `accountLogin`. Consistent with the producer (generacy-cloud#812), which seals `{ ...installationData, token, expiresAt, gitIdentityLogin }` at the top level (the cloud credential-refresh path builds the same flat shape). Extract via `parsed.gitIdentityLogin`. `accountLogin` is still needed and emitted by the refresh path, so C is wrong; B's nesting is needless divergence.

### Q3: Empty / Whitespace `gitIdentityLogin` Handling
**Context**: The spec's fallback rule ("when `gitIdentityLogin` is absent") is clear for the missing-field case, but does not specify behavior when the field is present but **empty string** or **whitespace-only**. The existing `accountLogin` check at `wizard-env-writer.ts:49` uses `typeof === 'string' && length > 0`, so empty strings are already treated as missing for `accountLogin`.
**Question**: How should an empty-string or whitespace-only `gitIdentityLogin` be treated?
**Options**:
- A: Treat empty/whitespace as missing — fall back to `accountLogin` (mirrors existing `accountLogin` empty-string handling; safe and forgiving).
- B: Treat empty as a sealed explicit value — emit nothing (skip both `GH_USERNAME` and `GH_EMAIL`), logging a warning. Forces re-sealing.
- C: Same as A, but additionally trim whitespace before use (`gitIdentityLogin.trim()`).

**Answer**: **C** — Trim, treat empty/whitespace as missing → fall back to `accountLogin`. Mirrors the existing `accountLogin` `length > 0` handling, and trimming matters here: a stray space would silently break both `git config user.name` and label-monitor assignee matching. Effectively: `const login = parsed.gitIdentityLogin?.trim() || parsed.accountLogin?.trim()`.

### Q4: `CLUSTER_GITHUB_USERNAME` Override Precedence
**Context**: `resolveClusterIdentity` in `orchestrator/src/services/identity.ts:39` checks `CLUSTER_GITHUB_USERNAME` (via `configUsername`) **before** `GH_USERNAME`. Out-of-Scope says the env-var override "remains as an escape hatch," but does not state whether it still wins over the new `gitIdentityLogin`-sourced `GH_USERNAME`.
**Question**: Should `CLUSTER_GITHUB_USERNAME` still take precedence over the new `gitIdentityLogin`-sourced `GH_USERNAME` (i.e., the existing resolution order is preserved unchanged)?
**Options**:
- A: Yes — preserve existing order. `CLUSTER_GITHUB_USERNAME` always wins; new field flows through `GH_USERNAME` as before. (No change to `identity.ts` resolution logic.)
- B: No — when `gitIdentityLogin` is sealed in a github-app credential, it should override `CLUSTER_GITHUB_USERNAME` (the cloud-side picker becomes the source of truth, env var becomes legacy).

**Answer**: **A** — Preserve existing order. `CLUSTER_GITHUB_USERNAME` stays the top-priority manual escape hatch; the new field flows through `GH_USERNAME` as today, so `resolveClusterIdentity`'s resolution order is unchanged (no `identity.ts` logic change). Making `gitIdentityLogin` override the explicit env var would defeat the purpose of an escape hatch — an operator who sets `CLUSTER_GITHUB_USERNAME` deliberately should win.
