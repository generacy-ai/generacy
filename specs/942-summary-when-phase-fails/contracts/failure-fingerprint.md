# Contract: `computeFailureFingerprint`

**Location**: `packages/orchestrator/src/worker/failure-fingerprint.ts` (NEW)

## Signature

```ts
export function computeFailureFingerprint(input: {
  phase: WorkflowPhase | string;
  evidence: CommandExitEvidence;
}): FailureFingerprint;
```

## Semantics (Q1→B default)

1. Extract `classifier` from `evidence.exitDescriptor`:
   - `/^failed post-exit: ([^ ]+) \(process exit \d+\)$/` → capture group 1
   - `/^killed \(SIGTERM\) after \d+ms$/` → `'timeout'`
   - `/^aborted$/` → `'aborted'`
   - `/^exit (\d+)$/` → `'exit-' + capture group 1`
   - Otherwise: literal `exitDescriptor` string (defensive; no known 5th shape today)
2. Choose `reasonText`:
   - If `evidence.reason` is present → use it (classifier-driven synthetic failures).
   - Else → use `evidence.outputTail` (real non-zero exits — outputTail is the diagnostic surface).
3. Compute: `sha256(phase + '\x00' + classifier + '\x00' + reasonText).slice(0, 16)` — hex, lowercase.

The null-byte joiner prevents field-boundary collisions (`ab||c` vs `a||bc`).

## Invariants (unit-tested)

- **INV-1** — Determinism: `f(x) === f(x)` for structurally equal `x`.
- **INV-2** — `runId`-agnostic: `runId` is not part of the input; two calls at different runId's with same evidence produce the same fingerprint.
- **INV-3** — Classifier-sensitive: `no-product-code-changes` and `product-diff-error` at the same phase produce different fingerprints.
- **INV-4** — Phase-sensitive: same classifier at `implement` vs `tasks` produces different fingerprints.
- **INV-5** — Reason-text-sensitive: two different reason texts within the same classifier produce different fingerprints.
- **INV-6** — Output-tail neutral (Q1→B only): two evidence blobs identical on phase+classifier+reason but with different `outputTail` produce the SAME fingerprint. (Under Q1→C this inverts.)

## Snappoll#8 replay

The three alerts on `christrudelpw/snappoll#8` all had:
- `phase = 'implement'`
- `evidence.exitDescriptor = 'failed post-exit: no-product-code-changes (process exit 0)'`
- `evidence.reason = 'Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.'`
- `evidence.outputTail = '(no output on either stream)'`

Under Q1→B this collapses to one fingerprint on all three calls. Under Q1→A the collapse is trivial (only 2 fields). Under Q1→C the collapse holds because outputTail is byte-identical.

## Failure modes

- **F-1** — `evidence.exitDescriptor` doesn't match any of the 4 patterns: fall through to the literal string. Fingerprint is still deterministic; no throw.
- **F-2** — `evidence.reason` and `evidence.outputTail` both empty: fingerprint over `phase + classifier + ''`. Still deterministic; the case is rare (empty-output pre-validate failure) and the resulting fingerprint correctly collapses two such failures.

---

# Contract: `parseFailureAlertMarker`

## Signature

```ts
export function parseFailureAlertMarker(
  commentBody: string,
): { fingerprint: FailureFingerprint; occurrence: number } | null;
```

## Semantics

1. Take line 1 (`commentBody.split('\n', 1)[0]`).
2. Match against `FAILURE_ALERT_MARKER_V2_REGEX = /<!-- fp:([0-9a-f]{16}):(\d+) -->/`.
3. If match: return `{ fingerprint: match[1], occurrence: parseInt(match[2], 10) }`.
4. If no match: return `null`.

Never throws.

## Invariants

- **INV-M1** — v1 markers (pre-#942, no fp block) return `null`.
- **INV-M2** — v2 markers on line 1 in any position (before or after the runId marker) parse successfully.
- **INV-M3** — Malformed fp markers (`<!-- fp:xyz:1 -->` with non-hex, `<!-- fp:9c4d3e2a1b0f8a7b:x -->` with non-numeric) return `null`.
- **INV-M4** — Multiple v2 markers on line 1 (should never happen — defensive): parses the first match, ignores the rest.
