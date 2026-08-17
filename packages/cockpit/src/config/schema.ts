import { z } from 'zod';
import { AgentEntrySchema } from '@generacy-ai/config';

/**
 * Named analysis roles the `/cockpit:auto` playbook dispatches to subagents.
 * Mirrors the agent files shipped in `claude-plugin-cockpit/agents/`.
 */
export const COCKPIT_AGENT_ROLES = [
  'clarifier',
  'reviewer',
  'validator',
  'fixer',
  'diagnoser',
] as const;
export type CockpitAgentRole = (typeof COCKPIT_AGENT_ROLES)[number];

/**
 * Per-role agent selectors for `/cockpit:auto` subagents. Each entry reuses
 * the orchestrator's `AgentEntrySchema` shape (`{ provider?, model?, effort? }`).
 * Resolution: role entry → `default` → inherit the loop session's model.
 */
export const CockpitAutoAgentsSchema = z
  .object({
    default: AgentEntrySchema.optional(),
    clarifier: AgentEntrySchema.optional(),
    reviewer: AgentEntrySchema.optional(),
    validator: AgentEntrySchema.optional(),
    fixer: AgentEntrySchema.optional(),
    diagnoser: AgentEntrySchema.optional(),
  })
  .strict();
export type CockpitAutoAgents = z.infer<typeof CockpitAutoAgentsSchema>;

/**
 * `cockpit.auto` block — configuration for the `/cockpit:auto` run loop.
 *
 * - `loop`: model/effort for the dispatch loop session itself. Consumed by
 *   launchers that start a `/cockpit:auto` session headlessly (the playbook
 *   cannot change its own session model mid-run).
 * - `heartbeatSeconds`: base interval for the belt-and-braces heartbeat
 *   (default 300). The playbook backs off from this base while drains stay
 *   empty; clamped to the harness ScheduleWakeup range [60, 3600].
 * - `quiet`: suppress transcript narration (ledger echoes, status tables,
 *   printed run summary) for headless runs. Durable records (ledger file,
 *   tracking-issue comments) are unaffected.
 * - `agents`: per-role model/effort overrides for the analysis subagents.
 */
export const CockpitAutoConfigSchema = z
  .object({
    loop: AgentEntrySchema.optional(),
    heartbeatSeconds: z.number().int().min(60).max(3600).optional(),
    quiet: z.boolean().optional(),
    agents: CockpitAutoAgentsSchema.optional(),
  })
  .strict();
export type CockpitAutoConfig = z.infer<typeof CockpitAutoConfigSchema>;

/**
 * Base `cockpit:` block fields. Parsed strictly-throwing by the loader (as
 * before); kept separate from `auto` so an invalid `auto` block degrades to a
 * warning instead of breaking `owner`/`assignee` consumers.
 */
export const CockpitBaseConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),
});

export const CockpitConfigSchema = CockpitBaseConfigSchema.extend({
  auto: CockpitAutoConfigSchema.optional(),
});

export type CockpitConfig = z.infer<typeof CockpitConfigSchema>;

export type CockpitConfigSource = 'cockpit-block' | 'defaults';

export interface LoadedCockpitConfig {
  config: CockpitConfig;
  source: CockpitConfigSource;
  warnings: string[];
}
