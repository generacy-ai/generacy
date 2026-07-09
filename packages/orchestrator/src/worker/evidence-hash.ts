import { createHash } from 'node:crypto';

/**
 * Structured extract from failing validate CLI stdout.
 * Sorted by `id` (lexicographic) for hash stability.
 * See specs/892-found-during-cockpit-v1/contracts/evidence-hash.md.
 */
export interface EvidenceExtract {
  failures: Array<{ id: string; firstError: string }>;
}

/**
 * Result of hashing validate CLI stdout — SHA-256 hex identity plus the
 * canonical `extract` that was hashed (surfaces in prompt + logs).
 */
export interface EvidenceHashResult {
  /** 64-character lower-case hex SHA-256. */
  hash: string;
  /** Canonical input to the hash; included in the fix prompt for debuggability. */
  extract: EvidenceExtract;
}

/**
 * Normalization pipeline applied to raw stdout before extraction (#892).
 *
 * Idempotent by construction — running the pipeline on already-normalized
 * text yields the same output. Ordering matters: ANSI first (so downstream
 * regexes see clean text), timestamps before paths (so ISO-8601 doesn't
 * partially match path regex), paths before PIDs (so bracket sequences in
 * paths aren't mistaken for PIDs).
 */
function normalize(stdout: string): string {
  let out = stdout;
  // 1. ANSI escapes (CSI + OSC).
  out = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  out = out.replace(/\x1b\][^\x07]*\x07/g, '');
  // 2. ISO-8601 timestamps → <TS>.
  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g,
    '<TS>',
  );
  // 3. Absolute paths → <PATH>. Only strip paths whose leading '/' is at a
  // non-alphanumeric boundary — this preserves import specifiers like
  // `@/components/CopyButton` and relative paths like `src/app/foo.ts` /
  // `./src/foo.ts` while normalizing true absolute paths like
  // `/home/node/workspaces/sniplink/src/app/foo.ts`.
  out = out.replace(/(?<![\w@.])(\/[a-zA-Z0-9._-]+)+/g, '<PATH>');
  // 4. PIDs → <PID>. Three forms: pid=<n>, PID: <n>, [<n>] where n >= 4 digits.
  out = out.replace(/\bpid=\d+\b/g, 'pid=<PID>');
  out = out.replace(/\bPID:\s*\d+\b/g, 'PID: <PID>');
  out = out.replace(/\[\d{4,}\]/g, '[<PID>]');
  // 5. Test-runner tmp identifiers → <TMP>. Absolute /tmp/... already
  // reduced by step 3; T-<hex>{8+} form is the vitest/jest one.
  out = out.replace(/T-[a-zA-Z0-9]{8,}/g, '<TMP>');
  // 6. Ports on localhost/127.0.0.1 → <PORT>.
  out = out.replace(/\b(localhost|127\.0\.0\.1):\d+\b/g, '$1:<PORT>');
  return out;
}

interface RawFailure {
  id: string;
  firstError: string;
}

/**
 * Extract next-build "Cannot find module" failures.
 */
function extractNextBuildMissingModule(normalized: string): RawFailure[] {
  const failures: RawFailure[] = [];
  const re = /Cannot find module '([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const modulePath = m[1]!;
    failures.push({
      id: `module:${modulePath}`,
      firstError: m[0]!,
    });
  }
  return failures;
}

/**
 * Extract next-build "Type error" failures.
 */
function extractNextBuildTypeError(normalized: string): RawFailure[] {
  const failures: RawFailure[] = [];
  // Type error line followed (within the same block) by a File: <path> line.
  const re = /Type error: (.+?)(?:\r?\n)[\s\S]{0,200}?File: (\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const summary = m[1]!.trim();
    const filePath = m[2]!;
    failures.push({
      id: `type:${filePath}:${summary.slice(0, 80)}`,
      firstError: `Type error: ${summary}`,
    });
  }
  return failures;
}

/**
 * Extract vitest failing test lines (` × <name>`).
 * `firstError` is the first indented (≥2 space) line following the × line.
 */
function extractVitestFailures(normalized: string): RawFailure[] {
  const failures: RawFailure[] = [];
  const lines = normalized.split('\n');
  const failedLineRe = /^\s*×\s+(.+?)(?:\s+\d+ms)?$/;
  for (let i = 0; i < lines.length; i++) {
    const m = failedLineRe.exec(lines[i]!);
    if (!m) continue;
    const testName = m[1]!.trim();
    let firstError = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 11); j++) {
      const l = lines[j]!;
      if (/^\s{2,}\S/.test(l)) {
        firstError = l.trim();
        break;
      }
    }
    failures.push({
      id: `test:${testName}`,
      firstError,
    });
  }
  return failures;
}

/**
 * Fallback path when no known pattern matches.
 * `id` = `hash:<first 16 hex of SHA-256 of full normalized transcript>`.
 * `firstError` = first non-empty line of normalized transcript.
 */
function fallbackExtract(normalized: string): RawFailure[] {
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const firstLine = normalized.split('\n').find((l) => l.length > 0) ?? '';
  return [
    {
      id: `hash:${digest.slice(0, 16)}`,
      firstError: firstLine,
    },
  ];
}

/**
 * Hash validate CLI stdout into a stable identity (#892).
 *
 * Extract categories are tried in order: next-build missing-module, next-build
 * type-error, vitest failures. If none match, falls back to a whole-transcript
 * hash so every stdout produces a well-defined result.
 *
 * See specs/892-found-during-cockpit-v1/contracts/evidence-hash.md.
 */
export function hashValidationEvidence(stdout: string): EvidenceHashResult {
  const normalized = normalize(stdout);

  const raw: RawFailure[] = [
    ...extractNextBuildMissingModule(normalized),
    ...extractNextBuildTypeError(normalized),
    ...extractVitestFailures(normalized),
  ];

  const failures = raw.length > 0 ? raw : fallbackExtract(normalized);

  // Sort by id for determinism (localeCompare with 'variant' avoids locale drift).
  failures.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'variant' }));

  const extract: EvidenceExtract = { failures };
  const canonical = JSON.stringify({ failures: extract.failures });
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return { hash, extract };
}
