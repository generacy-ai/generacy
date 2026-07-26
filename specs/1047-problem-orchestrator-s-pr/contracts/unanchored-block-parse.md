# Contract: `<!-- generacy-cockpit:unanchored-findings -->` block parser

**Feature**: #1047
**Consumer**: `packages/orchestrator/src/worker/pr-feedback-body-gate.ts`
**Producer**: `agency/packages/claude-plugin-cockpit` (upstream repo; consumer parses tolerant of both current and future producer shapes)
**Function**: `parseReviewBody(review: Review): ParsedReview`

## Input

A GitHub `Review` object (see `list-reviews-response.md`). Load-bearing fields:
- `body: string` — the raw review body markdown.
- `id: number` — reviewId for the resulting `ParsedReview`.
- `user.login: string` — reviewer for the resulting `ParsedReview`.
- `submittedAt: string` — passthrough on the result.

## Output

```typescript
interface ParsedReview {
  reviewId: number;
  reviewer: string;
  submittedAt: string;
  findings: ParsedFinding[];
}

interface ParsedFinding {
  index: number;         // 1-based, ordered by heading appearance
  files: string[];       // parsed from **Files:** line, comma-split, trimmed
  hasFilesLine: boolean; // FR-005 fail-open flag
}
```

## Parse algorithm

1. **Locate the marker.** Search `body` for the literal `<!-- generacy-cockpit:unanchored-findings -->`. If absent, return `{ ..., findings: [] }`.
2. **Extract the marker section.** Everything from the marker line to end-of-body (there is no closing marker in the current producer contract).
3. **Split by `### Finding <n>` headings.** Regex: `/^### Finding \d+\s*$/m`. Yields N chunks for N findings.
4. **For each chunk**:
   - Assign 1-based `index` in order of appearance (do NOT trust the `<n>` in the heading — producer may misnumber).
   - Search for a line matching `/^\*\*Files:\*\*\s*(.+)$/m` within the chunk.
   - If found: split the capture group on `,`, trim each entry, drop empties → `files`. Set `hasFilesLine: true`.
   - If not found: `files: []`, `hasFilesLine: false`.
5. **Return** `ParsedReview` with `findings` in appearance order.

## Fail-open cases (return trivially-empty output, do not throw)

| Case | Output |
|------|--------|
| Marker absent | `findings: []` |
| Marker present, zero `### Finding` sub-blocks | `findings: []` |
| `### Finding` sub-block with only prose, no `**Files:**` | that finding with `hasFilesLine: false` |
| `**Files:**` line with empty capture (`**Files:** `) | that finding with `files: [], hasFilesLine: true` (present but empty — same effect as false for gating) |
| Malformed / mid-truncated body | best-effort parse of what's there; return whatever findings are recoverable |
| Empty `body` | `findings: []` |

## Non-goals

- No path normalization. Paths returned verbatim (whitespace trimmed).
- No heuristic file-name extraction from prose outside `**Files:**` (FR-005 explicit).
- No support for alternative marker shapes. `<!-- generacy-cockpit:unanchored-findings -->` is the sole trigger.
- No case-insensitive matching. Marker and `**Files:**` are exact-case.
- No support for `### Finding 1:` (colon-terminated) headings. Regex is anchor-strict per producer contract.

## Example fixtures

### Absent marker

Input body:
```
This PR is looking good but there's a stale contract at auto.md:28 that
needs updating.
```

Output:
```json
{ "findings": [] }
```

### Marker present, single finding, with **Files:**

Input body:
```
Summary line.

<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** Stale contract description

**Failure scenario:** Reader consulting auto.md follows outdated contract.

**Files:** packages/claude-plugin-cockpit/commands/auto.md
```

Output:
```json
{
  "findings": [
    {
      "index": 1,
      "files": ["packages/claude-plugin-cockpit/commands/auto.md"],
      "hasFilesLine": true
    }
  ]
}
```

### Marker present, multi-finding, mixed with/without **Files:**

Input body:
```
<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** foo.md, bar.md

### Finding 2

**Finding:** Something without a Files line.
```

Output:
```json
{
  "findings": [
    { "index": 1, "files": ["foo.md", "bar.md"], "hasFilesLine": true },
    { "index": 2, "files": [], "hasFilesLine": false }
  ]
}
```

### Marker present, older producer (no **Files:** anywhere)

Input body:
```
<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** X

### Finding 2

**Finding:** Y
```

Output:
```json
{
  "findings": [
    { "index": 1, "files": [], "hasFilesLine": false },
    { "index": 2, "files": [], "hasFilesLine": false }
  ]
}
```

Gate effect (per FR-005): both findings have `hasFilesLine: false` → both contribute zero constraints → this review does not gate. Body still reaches the prompt via FR-002.
