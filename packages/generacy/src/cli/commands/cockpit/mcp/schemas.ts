/**
 * Zod input schemas for the seven cockpit MCP tools.
 *
 * `AWAIT_EVENTS_DEFAULTS` is the single source of truth for the long-poll /
 * coalesce / batch-size defaults — referenced by Zod defaults on
 * `AwaitEventsInputSchema` AND by the SC-006 fixture assertion. Do not fork.
 */
import { z } from 'zod';
import { listGates } from '../gate-vocabulary.js';

/** Structured issue/epic reference. */
export const IssueRefObjectSchema = z
  .object({
    owner: z
      .string()
      .min(1)
      .regex(/^[^/\s]+$/),
    repo: z
      .string()
      .min(1)
      .regex(/^[^/\s#]+$/),
    number: z.number().int().positive(),
  })
  .strict();

export type IssueRefObject = z.infer<typeof IssueRefObjectSchema>;

/** String form of the ref — passed to `resolveIssueContext` for normalization. */
export const IssueRefStringSchema = z.string().min(1);

/** Accepted `issue` input for every mutation tool. */
export const IssueRefInputSchema = z.union([IssueRefObjectSchema, IssueRefStringSchema]);
export type IssueRefInput = z.infer<typeof IssueRefInputSchema>;

/** Alias — `EpicRefInput` is shape-identical to `IssueRefInput`. */
export const EpicRefInputSchema = IssueRefInputSchema;
export type EpicRefInput = IssueRefInput;

const gateNames = listGates();

/**
 * Gate-name schema built at import time from the gate vocabulary. Unknown
 * gate names are rejected at the MCP boundary with `class: "unknown-gate"`.
 */
export const GateNameInputSchema = z.enum(gateNames as [string, ...string[]]);
export type GateNameInput = z.infer<typeof GateNameInputSchema>;

/** Concrete defaults for the long-poll event tool. Locked by SC-006 fixture. */
export const AWAIT_EVENTS_DEFAULTS = Object.freeze({
  maxWaitMs: 55_000,
  coalesceWindowMs: 3_000,
  maxBatchSize: 256,
});

export const AwaitEventsInputSchema = z
  .object({
    epic: EpicRefInputSchema,
    cursor: z.string().optional(),
    maxWaitMs: z.number().int().min(0).max(300_000).default(AWAIT_EVENTS_DEFAULTS.maxWaitMs),
    coalesceWindowMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(AWAIT_EVENTS_DEFAULTS.coalesceWindowMs),
    maxBatchSize: z
      .number()
      .int()
      .positive()
      .max(4_096)
      .default(AWAIT_EVENTS_DEFAULTS.maxBatchSize),
  })
  .strict();
export type AwaitEventsInput = z.infer<typeof AwaitEventsInputSchema>;

/** Per-tool input schemas — thin wrappers around the primitives. */
export const CockpitStatusInputSchema = z.object({ epic: EpicRefInputSchema }).strict();
export const CockpitContextInputSchema = z.object({ issue: IssueRefInputSchema }).strict();
export const CockpitAdvanceInputSchema = z
  .object({ issue: IssueRefInputSchema, gate: GateNameInputSchema })
  .strict();
export const CockpitResumeInputSchema = z.object({ issue: IssueRefInputSchema }).strict();
export const CockpitQueueInputSchema = z
  .object({ epic: EpicRefInputSchema, phase: z.string().min(1) })
  .strict();
/**
 * #928 — `cockpit_merge` accepts an **issue ref** (matching the CLI verb),
 * with an optional `pr: <number>` escape hatch mirroring CLI `--pr <number>`.
 * Field name change from `pr` (old, inverted) to `issue`; the old-field-name
 * redirection message is emitted at the tool handler when a `pr` key with a
 * non-numeric value is seen (per clarifications Q5 → B).
 */
export const CockpitMergeInputSchema = z
  .object({
    issue: IssueRefInputSchema,
    pr: z.number().int().positive().optional(),
  })
  .strict();
