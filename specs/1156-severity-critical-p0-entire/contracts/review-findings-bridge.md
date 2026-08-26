# Contract: `bridgeReviewArtifact` + `synthesizeMarker`

New pure module `packages/orchestrator/src/worker/review-findings-bridge.ts`. Zero I/O. Consumed by the `readFindingsArtifact` closure in `claude-cli-worker.ts`.

```ts
import type { ReviewArtifact, Severity } from './review-artifact.js';
import type { FindingsArtifact } from './review-findings-artifact.js';

/** Stable per-finding marker (FR-003, Q2=A): 24-hex sha256 of file + title. */
export function synthesizeMarker(file: string, title: string): string;

/** Bridge the engine-written ReviewArtifact into the ReviewPoster's FindingsArtifact (FR-002). */
export function bridgeReviewArtifact(
  artifact: ReviewArtifact,
  blockingSeverity: Severity,
): FindingsArtifact;
```

## `synthesizeMarker(file, title)`

- Returns `createHash('sha256').update(`${file}\0${title}`).digest('hex').slice(0, 24)`.
- **Stable**: identical `(file, title)` → identical marker across calls/rounds (SC-004 depends on this).
- **Distinct**: different `file` or different `title` → different marker with overwhelming probability.
- **Collision-safe boundary**: the `\0` separator makes `("ab","c")` and `("a","bc")` distinct.

## `bridgeReviewArtifact(artifact, blockingSeverity)`

- Output `verdict` === input `artifact.verdict` (pass-through).
- Output `findings.length` === input `artifact.findings.length` — **no finding dropped** (SC-002).
- Per finding:
  - `marker = synthesizeMarker(file, title)`.
  - `text = `${title}\n\n${detail}``.
  - `severity = SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity] ? 'blocking' : 'advisory'`.
  - `anchor = finding.line !== undefined ? { file: finding.file, line: finding.line } : undefined`.
  - `resolved = finding.status === 'resolved'`.
- No throw for any schema-valid `ReviewArtifact`.

### Severity threshold matrix (SEVERITY_RANK: critical=3, major=2, minor=1)

| finding.severity | blockingSeverity=critical | =major | =minor |
|---|---|---|---|
| critical | blocking | blocking | blocking |
| major | advisory | blocking | blocking |
| minor | advisory | advisory | blocking |
