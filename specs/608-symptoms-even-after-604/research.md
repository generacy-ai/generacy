# Research: VS Code tunnel name 20-char limit

**Feature**: #608 | **Date**: 2026-05-12

## Problem Analysis

### Root Cause

`loadOptionsFromEnv()` passes `GENERACY_CLUSTER_ID` (a 36-char UUID like `9e5c8a0d-755e-40b3-b0c3-43e849f0bb90`) directly as the `--name` argument to `code tunnel`. Microsoft's tunnel service enforces a 20-character maximum on tunnel names during first-time registration.

### Why Manual Testing Was Misleading

The `code` CLI caches tunnel registration in `~/.vscode/cli/code_tunnel.json`. After a successful registration (even with a long name via some edge case), subsequent invocations skip the validation. Fresh containers always hit the first-time path and fail.

## Derivation Alternatives Considered

| Approach | Format | Length | Pros | Cons | Decision |
|----------|--------|--------|------|------|----------|
| Strip hyphens + prefix | `g-{hex[0:18]}` | 20 | Deterministic, recognizable, 72-bit collision space | Slightly longer than minimum | **Selected** |
| SHA-256 hash + prefix | `g-{sha256[0:18]}` | 20 | Uniform distribution | Non-reversible, CPU cost (negligible) | Rejected — UUIDs already have good distribution |
| Base36 encoding | `g{base36(uuid)}` | ~27 | Compact | Still exceeds 20 chars | Rejected |
| Truncate raw UUID | `9e5c8a0d-755e-40b3` | 18 | Simple | Hyphens waste chars, not recognizable | Rejected |
| Random short name | `g-{random(18)}` | 20 | Simple | Not deterministic — changes on restart | Rejected — breaks VS Code Desktop reconnect |

## Design Decisions

### Prefix choice: `g-`

- 2 chars — minimal overhead
- Identifies tunnel as Generacy-managed (useful when listing tunnels in `code tunnel list`)
- Avoids conflict with user-created tunnels

### Collision resistance

18 hex chars = 72 bits of entropy. Birthday paradox collision probability:
- 1000 clusters: ~2^-52 (negligible)
- 1M clusters: ~2^-32 (still negligible)
- 2^36 clusters (~69 billion): 50% collision probability

Far beyond any realistic deployment scale.

### Web-side deep link strategy

Two options evaluated in the spec:

**(a) Cluster reports `tunnelName` via relay event** — Cloud reads it from Firestore cluster doc. Cluster is source of truth for the actual registered name. Decoupled — derivation can change without web-side update.

**(b) Web replicates `deriveTunnelName()`** — Simpler but creates coupling. Both sides must update in lockstep.

Decision: **(a)** — the `cluster.vscode-tunnel` event already includes `tunnelName` in its payload. This is a companion issue in `generacy-cloud`, not in scope here.

## Key Sources

- #584: Original `VsCodeTunnelProcessManager` implementation
- #606: CONNECTED_PATTERN fix + exit handler error emission
- #604: Idempotent start re-emit fix
- Microsoft tunnel name validation: empirically verified 20-char limit in CLI output
- `cluster-base#34`: vscode-cli volume for auth persistence across restarts
