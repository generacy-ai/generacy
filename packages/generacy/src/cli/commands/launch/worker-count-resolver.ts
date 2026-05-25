/**
 * Per-host worker count resolution for `generacy launch`.
 *
 * Three input axes (flag / TTY / launch-config tierCap) collapse to a single
 * positive integer for the orchestrator container. See specs/716 §data-model
 * for the full behavioral matrix.
 */
import type { LaunchConfig, LaunchOptions } from './types.js';
import { promptWorkerCount } from './prompts.js';

export const CLI_FALLBACK_TIER_CAP = 8;
export const SUGGESTED_FROM_HOST = 2;

export interface WorkerCountResolution {
  workerCount: number;
  source: 'flag' | 'prompt' | 'default';
  tierCapSource: 'launch-config' | 'fallback';
  warnings: string[];
}

const FALLBACK_WARNING =
  `tierCap fallback (${CLI_FALLBACK_TIER_CAP}) in use because launch-config did not include tierCap. ` +
  `Update once cloud companion lands.`;

function noTtyWarning(defaultWorkers: number): string {
  return (
    `No TTY detected and --workers not provided. Defaulting to ${defaultWorkers} workers. ` +
    `For reproducible scripted launches, pass --workers=${defaultWorkers} explicitly.`
  );
}

export async function resolveWorkerCount(
  opts: LaunchOptions,
  launchConfig: LaunchConfig,
  isTTY: boolean,
): Promise<WorkerCountResolution> {
  const tierCap = launchConfig.tierCap ?? CLI_FALLBACK_TIER_CAP;
  const tierCapSource: WorkerCountResolution['tierCapSource'] =
    launchConfig.tierCap != null ? 'launch-config' : 'fallback';
  const baseWarnings: string[] = tierCapSource === 'fallback' ? [FALLBACK_WARNING] : [];

  // Case A: --workers flag provided
  if (opts.workers != null) {
    if (!Number.isInteger(opts.workers) || opts.workers < 1) {
      throw new Error(`--workers must be a positive integer; got: ${opts.workers}`);
    }
    if (opts.workers > tierCap) {
      const suffix =
        tierCapSource === 'fallback'
          ? ' (CLI fallback cap; real cap will be available after the cloud companion ships).'
          : '. Upgrade your tier or reduce --workers.';
      throw new Error(`--workers=${opts.workers} exceeds tier cap of ${tierCap}${suffix}`);
    }
    return {
      workerCount: opts.workers,
      source: 'flag',
      tierCapSource,
      warnings: baseWarnings,
    };
  }

  const defaultWorkers = Math.min(tierCap, SUGGESTED_FROM_HOST);

  // Case B: TTY available — prompt
  if (isTTY) {
    const chosen = await promptWorkerCount(tierCap, defaultWorkers);
    return {
      workerCount: chosen,
      source: 'prompt',
      tierCapSource,
      warnings: baseWarnings,
    };
  }

  // Case C: no TTY, no flag — default with warning
  return {
    workerCount: defaultWorkers,
    source: 'default',
    tierCapSource,
    warnings: [noTtyWarning(defaultWorkers), ...baseWarnings],
  };
}
