# Contract: verification charter (review-charter.ts)

Extends the `verification` branch of `buildReviewCharter` (FR-001). Isolated change —
the `standard` branch stays byte-identical (FR-002).

## Behavior

When `input.profile === 'verification'`, the charter renders four clearly delineated
questions in place of the current generic "needs verification" paragraph:

1. **Root cause vs symptom** — does the change fix the underlying cause, or only mask
   a symptom?
2. **Regression test present that fails without the fix** — is there a new/changed
   test that would fail on the base ref and pass with this change?
3. **Scope creep** — does the diff include changes beyond what the fix strictly
   requires?
4. **Regression risk in changed lines** — do the changed lines risk breaking adjacent
   behavior?

## Preserved invariants (#1124)

- The "do NOT run tests or builds" section is unchanged (FR-003 upstream invariant).
- The empty/trivial-diff finding instruction is unchanged.
- The sidecar write instructions (`findings` array shape, no `verdict` field) are
  unchanged (FR-005 upstream invariant).
- The `standard` branch output is byte-identical to pre-change (FR-002).

## Tests (SC-002)

- `profile: 'verification'` → output contains all four questions (assert each).
- `profile: 'standard'` → output byte-identical to a captured pre-change snapshot.
- both profiles → still contain the "do NOT run tests" and sidecar-write sections.
