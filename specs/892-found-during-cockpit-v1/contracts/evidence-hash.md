# Contract: `hashValidationEvidence`

**Feature**: `892-found-during-cockpit-v1`
**Covers**: FR-003; Q3→B, D3.

## Signature

```ts
export function hashValidationEvidence(stdout: string): EvidenceHashResult;

export interface EvidenceHashResult {
  hash: string;              // 64-char lower-case hex SHA-256
  extract: EvidenceExtract;  // canonical hash input; also included in fix prompt
}

export interface EvidenceExtract {
  failures: Array<{ id: string; firstError: string }>;   // sorted lex by `id`
}
```

- **Input** `stdout: string` — combined stdout+stderr from a failing validate CLI (`next build`, `vitest run`, or fallback).
- **Output** deterministic across process runs. No environment leakage (no `Date.now`, no `Math.random`, no `process.pid`, no timezone influence).

## Semantics

Identity, not payload. The **prompt** to the fix agent (FR-005) is the *full stdout* — the extract is included there for reference. The **hash** is only used for dedupe (`isDuplicate`/`markProcessed` in `phase-tracker:validate-fix:<hash>` — see `data-model.md`).

## Normalization pipeline

Applied to raw stdout **once**, in order:

1. **Strip ANSI escapes**: `\x1b\[[0-9;]*[a-zA-Z]` (CSI sequences) + `\x1b\][^\x07]*\x07` (OSC). Both stripped to empty string.
2. **Timestamps → `<TS>`**: `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?`.
3. **Absolute paths → `<PATH>`**: `(\/[a-zA-Z0-9._-]+)+` — matches `/foo/bar/baz`. Repo-relative paths starting with `./` or bare `src/…` are preserved (the leading `/` anchor is what differentiates).
4. **PIDs → `<PID>`**: `\bpid=\d+\b` | `\bPID:\s*\d+\b` | `\[\d{4,}\]` (bracketed sequences of ≥4 digits, common in log prefixes).
5. **Temp dirs → `<TMP>`**: `/tmp/[a-zA-Z0-9_-]+` (already reduced to `<PATH>` in step 3; catch-all for OS temp-dir names retained for clarity) plus `T-[a-zA-Z0-9]{8,}` (test-runner-generated tmp identifiers).
6. **Ports → `<PORT>`**: `\b(localhost|127\.0\.0\.1):\d+\b` → `\1:<PORT>`.

Normalization is **idempotent**: running the pipeline on already-normalized text yields the same output. No re-normalization pass required.

## Extraction

Pattern matching applied to normalized text. First match wins per category:

### `next build` failures

- **Cannot find module**: `Cannot find module '([^']+)'`
  - `id`: `module:<capture>` (repo-relative import specifier, e.g., `@/components/CopyButton`).
  - `firstError`: full matched line (post-normalization).
- **Type error**: `Type error: (.*?)\r?\n.*?File: ([^\s]+)`
  - `id`: `type:<capture-2>:<capture-1-truncated-to-80-chars>`.
  - `firstError`: `Type error: <capture-1>`.

### `vitest` failures

- **Failed test line**: `^\s*× (.+?)(?:\s+\d+ms)?$`
  - `id`: `test:<capture>`.
  - `firstError`: the first indented (`\s{2,}`) line following the `×` line, or empty string if no indented line found within 10 lines.

### Fallback

If no failure pattern matches after scanning the whole transcript:

- `failures = [{ id: `hash:${sha256(normalizedTranscript).slice(0, 16)}`, firstError: firstLineOf(normalizedTranscript) }]`.

Guarantees every stdout produces a well-defined `EvidenceExtract`.

## Sorting

`failures` sorted by `id` (`String.prototype.localeCompare` with `sensitivity: 'variant'` — no locale surprises). Stable across process runs.

## Hashing

```ts
const canonical = JSON.stringify({ failures: extract.failures });
const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
```

- `JSON.stringify` output is deterministic in Node — property order matches source object property order, and `failures` is a sorted array.
- UTF-8 encoding is explicit (no platform default guesswork).

## Determinism guarantees

- **No time** — none of the pipeline reads `Date.now()` or `new Date()`.
- **No randomness** — no `Math.random`, no `crypto.randomBytes` outside the SHA input.
- **No env** — no `process.env`, no `TZ`, no `LANG` reads.
- **No I/O** — pure function; no filesystem, no network.
- **No `for…in`** — object iteration uses explicit key lists.

Two callers on two different clusters at two different times, given the same stdout, produce byte-identical `hash` and `extract`.

## Collision behavior

- Two *cosmetically different* runs of the same red produce the **same hash** by design (this is the correctness lever — the one-attempt bound depends on it).
- Two *genuinely different* reds may (rarely) collide. Failure mode: second red gets escalation instead of fresh attempt. Human sees it, spec §Q3→B "err safe."
- Collision floor: hash space is 2^256; realistic collision probability for two genuinely different reds is negligible. The Q3→B safety property comes from the *direction* of the failure (escalation, not silent skip), not from collision-freedom.

## Test surface

Fixtures at `packages/orchestrator/src/worker/__tests__/fixtures/`:

- `next-build-missing-module.stdout.txt` — canonical `Cannot find module '@/components/CopyButton'` transcript.
- `next-build-missing-module-rerun.stdout.txt` — same red, different timings + PIDs. Should hash identically.
- `next-build-type-error.stdout.txt` — canonical type error transcript.
- `vitest-single-failure.stdout.txt` — one `×` failure with indented error.
- `vitest-multi-failure.stdout.txt` — three failures across two files.
- `vitest-multi-failure-shuffled.stdout.txt` — same three failures, different emission order. Should hash identically to the non-shuffled version.
- `unknown-shape.stdout.txt` — non-matching text; exercises fallback path.
- `empty.stdout.txt` — empty string.

Required test cases:
1. **Same red, cosmetic re-run → same hash** — `next-build-missing-module` vs `next-build-missing-module-rerun`.
2. **Reordered failures → same hash** — `vitest-multi-failure` vs `vitest-multi-failure-shuffled`.
3. **Different module → different hash** — synthesize two `Cannot find module` reds with different module names.
4. **Extract fields correct** — assert `id` and `firstError` shapes for each pattern category.
5. **Fallback path** — `unknown-shape.stdout.txt` → `failures.length === 1` with `id: hash:…` prefix; hash is stable across two calls.
6. **Empty stdout** — well-defined output; hash is stable.
7. **Idempotent normalization** — pass already-normalized text; assert extraction still works and hash matches.
8. **No env leakage** — mock `Date.now`, `process.env.TZ`; assert output unchanged.

## Non-goals

- Does NOT include line/column numbers in `id`. Adding them would leak per-run compilation caching artifacts; a rebuild in a different cache state can shift columns.
- Does NOT include stack traces. Same reason — high-variance noise.
- Does NOT deduplicate identical failure entries within a single stdout. If the same test fails twice (rare), it appears twice in `failures` — but sort + JSON.stringify is stable, so the hash is still deterministic.
- Does NOT parse structured JSON output (test runner `--reporter=json`). Simplifies extraction and matches the spec's "stdout-inclusive" evidence source (FR-005).
