# Contract: Dependency-Block Marker Comments

Machine-read GitHub comment contracts for the dependency-blocked implement pause. All follow the codebase's HTML-marker convention: newest marker instance wins; markers are exact-match strings at the start of the comment body.

## 1. Block comment — `<!-- generacy-dependency-block -->`

**Writer**: phase loop's blocked branch (one per block cycle).
**Readers**: `DependencyMonitorService` (refs to poll), blocked branch (cycle counting).

```markdown
<!-- generacy-dependency-block -->
**Implementation paused — waiting on dependencies**

This issue's implement phase is blocked until the following are closed:

```json
{"on": ["generacy-ai/generacy#1198", "generacy-ai/generacy#1199"]}
```

The engine will resume automatically when all references above are closed.
```

Machine-parse rules:
- The fenced ```json block is the machine contract. Everything else is human-readable prose and MUST NOT be parsed.
- `on` is a non-empty array of **canonical** refs (`owner/repo#N`). Shorthand forms are normalized before posting; a reader never sees `#N` or bare `N`.
- Monitor reads the **newest** block comment only (by `created_at`).
- A block comment whose fenced JSON fails to parse is skipped with a warn; the monitor holds the gate and retries next poll.

## 2. Limit comment — `<!-- generacy-dependency-limit -->`

**Writer**: blocked branch when `cycleCount >= 3`.
**Readers**: blocked branch (cycle-counter reset baseline), humans.

```markdown
<!-- generacy-dependency-limit -->
**Dependency-block limit reached (3 cycles)**

Still open:
- generacy-ai/generacy#1198

Add `completed:dependency-limit` to this issue (or `cockpit advance --gate dependency-limit`) to grant another round of block cycles.
```

Rules:
- Posted alongside `waiting-for:dependency-limit` instead of a fourth `waiting-for:dependencies` pause.
- Cycle-counter baseline: only block comments with `created_at` **newer** than the newest limit comment count toward the cap.
- Dedupe: skip posting if a limit comment newer than the newest block comment already exists.

## 3. Re-arm comment (no marker)

**Writer**: `DependencyMonitorService` on re-arm. Informational only — nothing machine-reads it, so no marker.

```markdown
**Dependencies resolved — resuming implementation**

- generacy-ai/generacy#1198 — closed (completed)
- generacy-ai/generacy#1199 — ⚠ closed as **not planned** — verify this dependency was actually delivered
```

Flag rules (Q3=C):
- Issue closed with `state_reason: not_planned` → ⚠ line.
- PR closed without merge (`merged === false`) → ⚠ line (`⚠ closed without merging`).
- Clean closes (`completed`, merged PRs) → plain line.

## 4. Error comment — `<!-- generacy-dependency-block-error -->`

**Writer**: `DependencyMonitorService` after 3 consecutive read failures on a ref (Q5=B).

```markdown
<!-- generacy-dependency-block-error -->
**Cannot verify dependency state**

`generacy-ai/private-repo#7` has failed 3 consecutive reads (last error: HTTP 404).
The gate is still held and retries continue. If this ref is wrong or inaccessible,
advance the gate manually: `cockpit advance --gate dependencies`.
```

Rules:
- Deduped per block cycle: skip if an error comment newer than the newest block comment exists.
- Gate stays held; polling continues (never fail-open, FR-014).

## Ordering invariants

- Block comment is posted **before** `onGateHit` applies the gate labels: an orphaned marker (comment posted, gate application crashed) is harmless noise; a gate without refs strands the issue.
- All comment posting on the monitor side is best-effort try/catch — a comment failure never blocks the label/enqueue work.
