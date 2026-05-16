# Clarifications for #632 — App-Config Secrets Env Renderer

## Batch 1 — 2026-05-16

### Q1: Secret-to-Nonsecret Transition
**Context**: The spec covers `PUT` with `secret: true` (FR-003) and `DELETE` for secrets (FR-004), but doesn't address what happens when a user re-PUTs an existing secret env var with `secret: false` — transitioning from encrypted to plaintext storage. This edge case affects the route handler logic and determines whether secrets.env removal must be coordinated with plaintext env writes.
**Question**: When a user changes an env var from secret to non-secret (re-PUT with `secret: false`), should the system move the value from the encrypted backend to the plaintext env file and remove it from `secrets.env`?
**Options**:
- A: Move the value automatically (delete from backend, write to plaintext env file, remove from secrets.env)
- B: Reject the transition — require explicit DELETE + re-PUT with the new secret flag
- C: Out of scope for this issue — preserve current PUT behavior (overwrite regardless of prior secret flag)

**Answer**: *Pending*

### Q2: Directory Creation on Missing Tmpfs Mount
**Context**: The spec assumes `/run/generacy-app-config/` exists as a tmpfs mount provided by companion cluster-base issue (#38). If this PR ships before the companion, the directory won't exist. This affects deployment ordering and whether the feature can be tested/deployed independently.
**Question**: If `/run/generacy-app-config/` doesn't exist at daemon startup, should the secrets renderer create the directory itself or enter a degraded state?
**Options**:
- A: Create the directory with `mkdir -p` as a fallback (works without companion, but may land on persistent storage instead of tmpfs)
- B: Follow the AppConfigEnvStore fallback pattern (try preferred path, then `/tmp/generacy-app-config/` fallback, then disabled mode)
- C: Log a warning and skip secrets rendering entirely (strict dependency on companion issue)

**Answer**: *Pending*
