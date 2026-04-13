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
  condition: z.enum(['always', 'on-request', 'on-questions', 'on-failure']),
});

/**
 * Worker configuration schema
 */
export const WorkerConfigSchema = z.object({
  /** Timeout per phase in milliseconds */
  phaseTimeoutMs: z.number().int().min(60_000).default(600_000),
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
  /** Gate definitions keyed by issue label */
  gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
    'speckit-feature': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
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
