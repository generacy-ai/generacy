import { z } from 'zod';

export interface PhaseCompleteEvent {
  type: 'phase-complete';
  phase: string;
  epicRepo: string;
  epicNumber: number;
  ts: string;
  initial?: true;
}

export interface EpicCompleteEvent {
  type: 'epic-complete';
  epicRepo: string;
  epicNumber: number;
  ts: string;
  initial?: true;
}

export type AggregateEvent = PhaseCompleteEvent | EpicCompleteEvent;

const RepoRegex = /^[^/]+\/[^/]+$/;

export const PhaseCompleteEventSchema = z
  .object({
    type: z.literal('phase-complete'),
    phase: z.string().min(1),
    epicRepo: z.string().regex(RepoRegex),
    epicNumber: z.number().int().positive(),
    ts: z.string().datetime(),
    initial: z.literal(true).optional(),
  })
  .strict();

export const EpicCompleteEventSchema = z
  .object({
    type: z.literal('epic-complete'),
    epicRepo: z.string().regex(RepoRegex),
    epicNumber: z.number().int().positive(),
    ts: z.string().datetime(),
    initial: z.literal(true).optional(),
  })
  .strict();

export const AggregateEventSchema = z.discriminatedUnion('type', [
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
]);

export type AggregateEventValidated = z.infer<typeof AggregateEventSchema>;

export interface EmitAggregateOptions {
  stdout?: { write(chunk: string): boolean | void };
  skipValidate?: boolean;
}

export function emitAggregate(event: AggregateEvent, opts: EmitAggregateOptions = {}): void {
  const out = opts.stdout ?? process.stdout;
  const validated = opts.skipValidate === true ? event : AggregateEventSchema.parse(event);
  out.write(`${JSON.stringify(validated)}\n`);
}
