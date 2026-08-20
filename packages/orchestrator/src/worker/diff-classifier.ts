/**
 * Diff classifier (#1134 FR-003–FR-008, Decision 1).
 *
 * Pure, deterministic, no I/O. Categorizes a changed-file set into one of five
 * classifications so the targeted-validate wiring can decide how (or whether) to
 * narrow the built-in default validate command. Guard precedence is fixed and
 * order-sensitive; exactly one branch fires; never throws.
 *
 * Glob sets are the closed Q2=A set (see `contracts/diff-classifier.md`):
 * - root-config (force full): root-only lockfiles / `pnpm-workspace.yaml` /
 *   `tsconfig*.json`, plus anything under `.github/workflows/`.
 * - docs: any `*.md`, anything under `docs/`.
 * - test: `*.{test,spec}.{ts,tsx,js,jsx}`, anything under a `__tests__/` segment.
 */

export type Classification =
  | { kind: 'full-fallback'; reason: string }
  | { kind: 'single-package-plain'; reason: string }
  | { kind: 'docs-only-skip-tests' }
  | { kind: 'test-only'; testFiles: string[] }
  | { kind: 'targeted' };

export interface ClassifyInput {
  /** Changed-file paths, repo-relative, against origin/<base>. */
  changedFiles: string[];
  /** True iff pnpm-workspace.yaml exists at the checkout root. */
  isWorkspace: boolean;
}

const ROOT_LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pnpm-workspace.yaml',
]);

/**
 * Root-config match. Bare filenames match root-only (no `/` in the path); the
 * CI-workflow glob matches anything under `.github/workflows/`. Returns the
 * offending file (for the `reason`) or null.
 */
function rootConfigMatch(file: string): string | null {
  if (file.startsWith('.github/workflows/')) return file;
  // Root-only: a path with no directory component.
  if (!file.includes('/')) {
    if (ROOT_LOCKFILES.has(file)) return file;
    if (/^tsconfig.*\.json$/.test(file)) return file;
  }
  return null;
}

function isDoc(file: string): boolean {
  return file.endsWith('.md') || file.startsWith('docs/');
}

function isTest(file: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) return true;
  return /(^|\/)__tests__\//.test(file);
}

/**
 * Classify a changed-file set. Ordered, first-match-wins:
 *   0. empty diff              → full-fallback (reason 'empty-diff')
 *   1. any root-config glob    → full-fallback (reason 'root-config: <file>')
 *   2. !isWorkspace            → single-package-plain (reason 'not-a-workspace')
 *   3. all files are docs      → docs-only-skip-tests
 *   4. all files are tests     → test-only (testFiles = the changed files)
 *   5. otherwise               → targeted
 */
export function classifyDiff(input: ClassifyInput): Classification {
  const { changedFiles, isWorkspace } = input;

  if (changedFiles.length === 0) {
    return { kind: 'full-fallback', reason: 'empty-diff' };
  }

  for (const file of changedFiles) {
    const match = rootConfigMatch(file);
    if (match !== null) {
      return { kind: 'full-fallback', reason: `root-config: ${match}` };
    }
  }

  if (!isWorkspace) {
    return { kind: 'single-package-plain', reason: 'not-a-workspace' };
  }

  if (changedFiles.every(isDoc)) {
    return { kind: 'docs-only-skip-tests' };
  }

  if (changedFiles.every(isTest)) {
    return { kind: 'test-only', testFiles: [...changedFiles] };
  }

  return { kind: 'targeted' };
}

/**
 * Test-glob predicate exported for reuse by the `failThenPass` wiring
 * (changed-test-file set = changedFiles ∩ this predicate). Matches the same
 * closed test-glob set the classifier uses (FR-003).
 */
export function isTestFile(file: string): boolean {
  return isTest(file);
}
