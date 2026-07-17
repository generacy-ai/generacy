import { z } from 'zod';
import { COCKPIT_STATES } from '@generacy-ai/cockpit';
import type { CockpitEvent } from './diff.js';

export const CockpitEventSchema = z.object({
  type: z.literal('issue-transition'),
  ts: z.string().datetime(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  kind: z.enum(['issue', 'pr']),
  number: z.number().int().positive(),
  from: z.union([z.enum(COCKPIT_STATES), z.null()]),
  to: z.union([z.enum(COCKPIT_STATES), z.null()]),
  sourceLabel: z.string().nullable(),
  url: z.string().url(),
  event: z.enum(['label-change', 'issue-closed', 'pr-merged', 'pr-closed', 'pr-checks']),
  labels: z.array(z.string()),
  initial: z.literal(true).optional(),
  checks: z.enum(['green', 'red', 'pending']).optional(),
});

export type CockpitEventValidated = z.infer<typeof CockpitEventSchema>;

export interface EmitOptions {
  stdout?: { write(chunk: string): boolean | void };
  skipValidate?: boolean;
}

/**
 * Emit one NDJSON-encoded line per CockpitEvent.
 *
 * Validation runs by default (dev-time defense). Writes via a single
 * `process.stdout.write` (no `console.log` — that interleaves under high
 * concurrency).
 */
export function emit(event: CockpitEvent, opts: EmitOptions = {}): void {
  const out = opts.stdout ?? process.stdout;
  const stamped = { ...event, type: 'issue-transition' as const };
  const validated = opts.skipValidate === true ? stamped : CockpitEventSchema.parse(stamped);
  out.write(`${JSON.stringify(validated)}\n`);
}
