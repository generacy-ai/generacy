import type { GeneracyConfig } from '../../../config/index.js';

// ---------------------------------------------------------------------------
// Check categories — used for grouping output
// ---------------------------------------------------------------------------

export type CheckCategory =
  | 'system'
  | 'config'
  | 'credentials'
  | 'packages'
  | 'services';

// ---------------------------------------------------------------------------
// Check definition — each health check implements this interface
// ---------------------------------------------------------------------------

export interface CheckDefinition {
  /** Unique identifier, e.g. 'docker', 'config', 'github-token'. */
  id: string;

  /** Human-readable label shown in output. */
  label: string;

  /** Category for grouping: system, config, credentials, packages, services. */
  category: CheckCategory;

  /** IDs of checks that must pass before this one runs. */
  dependencies: string[];

  /** Priority: P1 checks always run; P2 can be skipped. */
  priority: 'P1' | 'P2';

  /** The check function. */
  run: (context: CheckContext) => Promise<CheckResult>;

  /** Optional auto-fix function (reserved for future use). */
  fix?: (context: CheckContext) => Promise<FixResult>;
}

// ---------------------------------------------------------------------------
// Check context — shared state passed to every check
// ---------------------------------------------------------------------------

export interface CheckContext {
  /** Resolved config file path (null if not yet found). */
  configPath: string | null;

  /** Parsed config (null if config check failed or hasn't run). */
  config: GeneracyConfig | null;

  /** Parsed env vars from .generacy/generacy.env. */
  envVars: Record<string, string> | null;

  /** Whether running inside a dev container. */
  inDevContainer: boolean;

  /** Whether --verbose was passed. */
  verbose: boolean;

  /** Project root directory (null if not yet resolved). */
  projectRoot: string | null;
}

// ---------------------------------------------------------------------------
// Check result — returned by each check's run() function
// ---------------------------------------------------------------------------

export interface CheckResult {
  /** Outcome of the check. */
  status: 'pass' | 'fail' | 'warn' | 'skip';

  /** Short description of the result. */
  message: string;

  /** Actionable fix suggestion (shown on fail/warn). */
  suggestion?: string;

  /** Additional detail shown in --verbose mode. */
  detail?: string;

  /** Data to merge into CheckContext for dependent checks. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Doctor CLI options
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  /** Run only these checks (and their transitive dependencies). */
  check?: string[];

  /** Skip these checks. */
  skip?: string[];

  /** Output results as JSON. */
  json?: boolean;

  /** Show detailed diagnostic information. */
  verbose?: boolean;

  /** Attempt to auto-fix detected issues (reserved for future use). */
  fix?: boolean;
}

// ---------------------------------------------------------------------------
// Doctor report — the full output structure (used for JSON mode)
// ---------------------------------------------------------------------------

export interface DoctorReportCheckEntry {
  id: string;
  label: string;
  category: CheckCategory;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  suggestion?: string;
  detail?: string;
  duration_ms?: number;
}

export interface DoctorReportSummary {
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  total: number;
}

export interface DoctorReport {
  version: number;
  timestamp: string;
  summary: DoctorReportSummary;
  checks: DoctorReportCheckEntry[];
  exitCode: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Fix result — stub for future auto-fix support
// ---------------------------------------------------------------------------

export interface FixResult {
  /** Whether the fix was applied successfully. */
  success: boolean;

  /** Description of what was done (or why it failed). */
  message: string;
}
