# Data Model: phase-start-ref key migration + unresolvable-ref handling (#1112)

This fix introduces no new persisted entities. It adds one method to an existing
interface and drains a pre-existing legacy key format. The "entities" below are
the Redis keys and the client capability the fix touches.

## Redis keys (via `PhaseTracker` raw-key API)

### Branch-scoped phase-start ref (current, #1110)

- **Key**: `phase-start-ref:<owner>:<repo>:<issue>:<branch>:<phase>`
- **Value**: a git commit SHA, 7-40 lower/upper-hex (validated by `isValidCommitSha`).
- **TTL**: `PHASE_START_REF_TTL_SECONDS` = `7 * 24 * 60 * 60` (7 days).
- **Branch component**: `context.branch ?? 'no-branch'`.
- **Lifecycle**: written on first phase entry (or on migration / re-capture), read on
  every increment, cleared on the pass path (`clearRaw`), TTL backstop on failure.
- **Change in #1112**: additionally written as the *destination* of a legacy migration
  (Q1=A), and overwritten with fresh HEAD when a reused ref fails the resolve-check.

### Legacy phase-start ref (pre-#1110) — drained, never written

- **Key**: `phase-start-ref:<owner>:<repo>:<issue>:<phase>` (no branch component).
- **Value**: same SHA shape as above.
- **TTL**: inherited 7 days from the pre-#1110 build; never refreshed by the new build.
- **Lifecycle in #1112**: read **once**, lazily, only on a branch-scoped miss (FR-001).
  Cleared on **any** read — accepted, shape-invalid, or unresolvable (FR-002/Q3=A).
  Post-#1110 nothing constructs this key, so once drained it cannot reappear.

**Value validation (both keys):** `isValidCommitSha(value)` = `typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value)`. A value failing this is treated as absent — never used as a diff base — and (for the legacy key) still cleared.

## Capture/reuse state machine (per phase entry, `PHASES_REQUIRING_CHANGES` only)

```
read branchKey
  ├─ valid SHA ──────────────────────────────────► existing = branchRef
  └─ miss/invalid
        read legacyKey (FR-001, lazy)
          ├─ absent ──────────────────────────────► existing = null
          └─ present (record: must clear — FR-002/Q3=A)
                ├─ valid SHA
                │    setValueRaw(branchKey, ref)  (Q1=A: write first)
                │    clearRaw(legacyKey)
                │    existing = legacyRef
                └─ shape-invalid
                     clearRaw(legacyKey)
                     existing = null

if existing != null:
  commitExistsInCheckout(existing)              (FR-003)
    ├─ true  ──────────────────────────────────► phaseStartRef = existing   (reuse)
    ├─ false (exit 1) ─────────────────────────► existing = null            (re-capture)
    └─ throw (exit 128) ───────────────────────► propagate → catch → phaseStartRef undefined
                                                   → downstream product-diff-error (FR-005)

if existing == null:
  captured = getCurrentCommitSha()              (FR-004)
  setValueRaw(branchKey, captured)
  phaseStartRef = captured
```

## Client capability (new)

### `GitHubClient.commitExistsInCheckout(sha: string): Promise<boolean>`

- **Command**: `git rev-parse --verify --quiet <sha>^{commit}` in `workdir` (== `context.checkoutPath`).
- **Returns**: `true` on exit 0 (commit present), `false` on exit 1 (commit missing — full or abbreviated sha).
- **Throws**: on any other exit (e.g. 128 — environment fault) with exit code + stderr, so a genuine git fault is never misread as a missing commit (Q4=B / FR-003 / FR-005).
- **Implementers**: `GhCliGitHubClient` (the sole implementer of `GitHubClient`).

## Relationships / invariants

- `commitExistsInCheckout` gates **every** reused ref — direct branch-scoped hit *and* legacy-migrated value — before it reaches `computePhaseScopedProductDiff` / `getFilesChangedByOwnCommits`.
- The branch-scoped write always precedes the legacy clear (Q1=A) so a crash between them never loses the window.
- Consume-once: exactly one legacy `getValueRaw` per phase entry, and a paired `clearRaw` iff a value was read (Q3=A).
- No change to `PHASES_REQUIRING_CHANGES`, `EXCLUDED_PATH_PREFIXES`, `EXCLUDED_EXACT_PATHS`, the diff-window semantics, escalation surface, or TTL/namespace (US3/SC-004).
