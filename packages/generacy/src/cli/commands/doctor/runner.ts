import type {
  CheckContext,
  CheckDefinition,
  CheckResult,
  DoctorOptions,
  DoctorReport,
  DoctorReportCheckEntry,
  DoctorReportSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for checks that involve network calls (ms). */
const CHECK_TIMEOUT_MS = 5_000;

/** Categories that involve network calls and should be subject to timeout. */
const NETWORK_CATEGORIES = new Set(['credentials', 'services']);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CheckOutcome {
  result: CheckResult;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// runChecks — main entry point
// ---------------------------------------------------------------------------

/**
 * Execute an ordered list of checks, running independent checks concurrently
 * within each dependency tier.
 *
 * The `checks` array **must** be in topological (dependency) order — as
 * returned by `CheckRegistry.resolve()`. The runner groups them into tiers
 * where all items in a tier have their dependencies satisfied by earlier tiers,
 * then runs each tier concurrently via `Promise.all`.
 *
 * @returns A `DoctorReport` containing per-check results and a summary.
 */
export async function runChecks(
  checks: CheckDefinition[],
  options: DoctorOptions,
): Promise<DoctorReport> {
  // Shared mutable context populated progressively by checks
  const context: CheckContext = {
    configPath: null,
    config: null,
    envVars: null,
    inDevContainer: !!process.env.REMOTE_CONTAINERS,
    verbose: options.verbose ?? false,
    projectRoot: null,
  };

  // Outcomes keyed by check ID
  const outcomes = new Map<string, CheckOutcome>();

  // Build execution tiers
  const tiers = buildTiers(checks);

  for (const tier of tiers) {
    await Promise.all(
      tier.map(async (check) => {
        const outcome = await executeCheck(check, context, outcomes);
        outcomes.set(check.id, outcome);
      }),
    );
  }

  // Assemble report
  const entries: DoctorReportCheckEntry[] = checks.map((check) => {
    const outcome = outcomes.get(check.id)!;
    const entry: DoctorReportCheckEntry = {
      id: check.id,
      label: check.label,
      category: check.category,
      status: outcome.result.status,
      message: outcome.result.message,
      duration_ms: outcome.duration_ms,
    };
    if (outcome.result.suggestion) entry.suggestion = outcome.result.suggestion;
    if (outcome.result.detail) entry.detail = outcome.result.detail;
    return entry;
  });

  const summary = computeSummary(entries);
  const exitCode = computeExitCode(entries);

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    summary,
    checks: entries,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Tier building
// ---------------------------------------------------------------------------

/**
 * Group checks into execution tiers. Each tier contains checks whose
 * dependencies all appear in earlier tiers (or have no dependencies).
 *
 * Assumes `checks` is already in topological order.
 */
function buildTiers(checks: CheckDefinition[]): CheckDefinition[][] {
  const tiers: CheckDefinition[][] = [];
  // Track which tier each check is assigned to
  const tierIndex = new Map<string, number>();

  for (const check of checks) {
    // The earliest tier this check can run in is one past the highest tier
    // of any of its dependencies.
    let maxDepTier = -1;
    for (const dep of check.dependencies) {
      const depTier = tierIndex.get(dep);
      if (depTier !== undefined && depTier > maxDepTier) {
        maxDepTier = depTier;
      }
    }

    const myTier = maxDepTier + 1;
    tierIndex.set(check.id, myTier);

    while (tiers.length <= myTier) {
      tiers.push([]);
    }
    tiers[myTier]!.push(check);
  }

  return tiers;
}

// ---------------------------------------------------------------------------
// Single check execution
// ---------------------------------------------------------------------------

/**
 * Execute a single check, handling:
 * - Dependency skip propagation
 * - Timeout wrapping for network checks
 * - Context merging from result data
 * - Duration tracking
 */
async function executeCheck(
  check: CheckDefinition,
  context: CheckContext,
  outcomes: Map<string, CheckOutcome>,
): Promise<CheckOutcome> {
  // Check if any dependency failed or was skipped due to a failure
  const failedDep = findFailedDependency(check, outcomes);
  if (failedDep) {
    return {
      result: {
        status: 'skip',
        message: `Skipped — dependency '${failedDep}' failed`,
      },
      duration_ms: 0,
    };
  }

  const start = performance.now();

  try {
    let result: CheckResult;

    if (NETWORK_CATEGORIES.has(check.category)) {
      result = await withTimeout(check.run(context), CHECK_TIMEOUT_MS, check.id);
    } else {
      result = await check.run(context);
    }

    // Merge any data the check wants to share into the context
    if (result.data) {
      mergeContextData(context, result.data);
    }

    const duration_ms = Math.round(performance.now() - start);
    return { result, duration_ms };
  } catch (error) {
    const duration_ms = Math.round(performance.now() - start);
    return {
      result: {
        status: 'fail',
        message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        detail: error instanceof Error ? error.stack : undefined,
      },
      duration_ms,
    };
  }
}

// ---------------------------------------------------------------------------
// Dependency failure detection
// ---------------------------------------------------------------------------

/**
 * Returns the ID of the first dependency that failed (status `'fail'`) or
 * was itself skipped due to a dependency failure. Returns `undefined` if
 * all dependencies passed or warned.
 */
function findFailedDependency(
  check: CheckDefinition,
  outcomes: Map<string, CheckOutcome>,
): string | undefined {
  for (const depId of check.dependencies) {
    const depOutcome = outcomes.get(depId);
    if (!depOutcome) continue; // not yet run — shouldn't happen in tier model
    if (depOutcome.result.status === 'fail' || depOutcome.result.status === 'skip') {
      return depId;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a check promise with a timeout. If the check doesn't resolve within
 * `ms` milliseconds, return a `fail` result.
 */
async function withTimeout(
  promise: Promise<CheckResult>,
  ms: number,
  checkId: string,
): Promise<CheckResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<CheckResult>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: 'fail',
        message: `Check timed out after ${ms / 1000}s`,
        suggestion: `The '${checkId}' check did not respond within ${ms / 1000} seconds. Check your network connection.`,
      });
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Context merging
// ---------------------------------------------------------------------------

/**
 * Merge data from a check result into the shared context. Only known
 * context keys are merged.
 */
function mergeContextData(context: CheckContext, data: Record<string, unknown>): void {
  if ('configPath' in data && typeof data.configPath === 'string') {
    context.configPath = data.configPath;
  }
  if ('config' in data && data.config !== undefined) {
    context.config = data.config as CheckContext['config'];
  }
  if ('envVars' in data && data.envVars !== undefined) {
    context.envVars = data.envVars as CheckContext['envVars'];
  }
  if ('projectRoot' in data && typeof data.projectRoot === 'string') {
    context.projectRoot = data.projectRoot;
  }
}

// ---------------------------------------------------------------------------
// Summary & exit code
// ---------------------------------------------------------------------------

function computeSummary(entries: DoctorReportCheckEntry[]): DoctorReportSummary {
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let skipped = 0;

  for (const entry of entries) {
    switch (entry.status) {
      case 'pass':
        passed++;
        break;
      case 'fail':
        failed++;
        break;
      case 'warn':
        warnings++;
        break;
      case 'skip':
        skipped++;
        break;
    }
  }

  return { passed, failed, warnings, skipped, total: entries.length };
}

function computeExitCode(entries: DoctorReportCheckEntry[]): 0 | 1 | 2 {
  for (const entry of entries) {
    if (entry.message.startsWith('Internal error:')) {
      return 2;
    }
  }

  for (const entry of entries) {
    if (entry.status === 'fail') {
      return 1;
    }
  }

  return 0;
}
