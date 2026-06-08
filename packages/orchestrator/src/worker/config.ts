import { z } from 'zod';
import type { WorkflowPhase } from './types.js';

/**
 * Gate definition schema for pausing workflow at review checkpoints
 */
export const GateDefinitionSchema = z.object({
  /** Phase that triggers gate check */
  phase: z.enum(['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'] as const satisfies readonly WorkflowPhase[]),
  /** Label to add when gate is active */
  gateLabel: z.string(),
  /** When to activate the gate */
  condition: z.enum(['always', 'on-request', 'on-questions', 'on-failure', 'on-sibling-review']),
});

/**
 * Per-phase wall-clock timeout overrides (milliseconds).
 *
 * Each CLI phase is killed (SIGTERM → grace → SIGKILL) once its wall-clock
 * runtime exceeds its timeout. The `plan` and `implement` phases are
 * structurally heavier than the others — `plan` fans out research subagents,
 * `implement` writes code — so they default to a larger budget than the flat
 * `phaseTimeoutMs`. Any phase without an override falls back to `phaseTimeoutMs`.
 *
 * Defined per-field (rather than as a `z.record`) so that overriding one phase
 * via config/env does not drop the defaults for the others — Zod applies the
 * remaining field defaults when the object is present but partial.
 *
 * `validate` is intentionally excluded: that phase runs a shell command via a
 * separate code path with its own timeout, not `phaseTimeoutMs`.
 */
export const PhaseTimeoutOverridesSchema = z
  .object({
    specify: z.number().int().min(60_000).optional(),
    clarify: z.number().int().min(60_000).optional(),
    plan: z.number().int().min(60_000).default(3_600_000),
    tasks: z.number().int().min(60_000).optional(),
    implement: z.number().int().min(60_000).default(3_600_000),
  })
  .default({});
export type PhaseTimeoutOverrides = z.infer<typeof PhaseTimeoutOverridesSchema>;

/**
 * Worker configuration schema
 */
export const WorkerConfigSchema = z.object({
  /** Fallback timeout per phase in milliseconds (used when no per-phase override applies) */
  phaseTimeoutMs: z.number().int().min(60_000).default(1_200_000),
  /** Per-phase timeout overrides keyed by phase name */
  phaseTimeoutOverrides: PhaseTimeoutOverridesSchema,
  /** Base directory for repo checkouts */
  workspaceDir: z.string().default('/tmp/orchestrator-workspaces'),
  /** Grace period for shutdown in milliseconds */
  shutdownGracePeriodMs: z.number().int().min(1000).default(5000),
  /** Command to run during the validate phase */
  validateCommand: z.string().default('pnpm test && pnpm build'),
  /** Command to run before validation to install dependencies (empty string to skip) */
  preValidateCommand: z.string().default("pnpm install && pnpm -r --filter './packages/*' build"),
  /** Maximum retries for implement phase when partial progress is detected */
  maxImplementRetries: z.number().int().min(0).max(5).default(2),
  /** Credential role from .generacy/config.yaml defaults.role — when set, credentials are populated on launch requests */
  credentialRole: z.string().optional(),
  /** Gate definitions keyed by issue label */
  gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
    'speckit-feature': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
      { phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' },
    ],
    'speckit-bugfix': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' },
    ],
    'speckit-epic': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'tasks', gateLabel: 'waiting-for:tasks-review', condition: 'always' },
    ],
  }),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Resolve the wall-clock timeout (ms) for a CLI phase: the per-phase override
 * if one is configured, otherwise the flat `phaseTimeoutMs` fallback.
 */
export function resolvePhaseTimeoutMs(
  config: WorkerConfig,
  phase: Exclude<WorkflowPhase, 'validate'>,
): number {
  // Optional-chained: configs built by hand (tests, direct construction) bypass
  // Zod and may omit phaseTimeoutOverrides entirely.
  return config.phaseTimeoutOverrides?.[phase] ?? config.phaseTimeoutMs;
}
