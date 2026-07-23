/**
 * Zod input schemas for the seven cockpit MCP tools.
 *
 * `AWAIT_EVENTS_DEFAULTS` is the single source of truth for the long-poll /
 * coalesce / batch-size defaults — referenced by Zod defaults on
 * `AwaitEventsInputSchema` AND by the SC-006 fixture assertion. Do not fork.
 */
import { z } from 'zod';
import { listGates } from '../gate-vocabulary.js';
import { SESSION_ID_REGEX } from './claim/payload.js';
import {
  GateOpenInputSchema as InternalGateOpenInputSchema,
  GateAckInputSchema as InternalGateAckInputSchema,
} from './gates/schemas.js';

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
/**
 * #935 — `cockpit_queue` accepts either the phase form (existing) or a new
 * single-issue form. Discriminated union at Zod level so TypeScript consumers
 * of the tool see both variants explicitly.
 */
export const CockpitQueueInputSchema = z.union([
  z.object({ epic: EpicRefInputSchema, phase: z.string().min(1) }).strict(),
  z.object({ issue: IssueRefInputSchema }).strict(),
]);
export type CockpitQueueInput = z.infer<typeof CockpitQueueInputSchema>;

/** #935 — scope-mutation tool schemas. */
export const CockpitScopeAddInputSchema = z
  .object({ scope: EpicRefInputSchema, issue: IssueRefInputSchema })
  .strict();
export type CockpitScopeAddInput = z.infer<typeof CockpitScopeAddInputSchema>;

export const CockpitScopeRemoveInputSchema = z
  .object({ scope: EpicRefInputSchema, issue: IssueRefInputSchema })
  .strict();
export type CockpitScopeRemoveInput = z.infer<typeof CockpitScopeRemoveInputSchema>;
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

/**
 * #958 — `cockpit_relay_clarify_answers` input schema.
 *
 * Structured answer payload: keys are positive integers (question numbers),
 * values are non-empty strings. The tool refuses to render an empty `Q<n>:`
 * line; callers omit a key rather than pass an empty string.
 *
 * The `z.record(z.coerce.number()...)` shape accepts JSON object keys as
 * strings (as they arrive over MCP) and coerces to numeric keys for the
 * downstream formatter's `Record<number, string>` API.
 */
/**
 * #1015 — `cockpit_claim` (idempotent acquire-or-refresh-or-takeover).
 *
 * `sessionId` is opaque to the claim mechanism; the regex is a shape check
 * only. `takeover` is explicit — default `false` (never implicit).
 */
export const CockpitClaimInputSchema = z
  .object({
    scope: IssueRefInputSchema,
    sessionId: z.string().regex(SESSION_ID_REGEX, {
      message: 'sessionId must be 16-64 hex chars',
    }),
    ledger: z.string().min(1).max(512),
    takeover: z.boolean().default(false),
  })
  .strict();
export type CockpitClaimInput = z.infer<typeof CockpitClaimInputSchema>;

/**
 * #1015 — `cockpit_release` (explicit release by session id).
 *
 * No `takeover` — release is by-session-id only. Forcibly clearing a
 * non-owned claim is a two-step: `cockpit_claim` with `takeover: true`
 * followed by `cockpit_release`.
 */
export const CockpitReleaseInputSchema = z
  .object({
    scope: IssueRefInputSchema,
    sessionId: z.string().regex(SESSION_ID_REGEX, {
      message: 'sessionId must be 16-64 hex chars',
    }),
  })
  .strict();
export type CockpitReleaseInput = z.infer<typeof CockpitReleaseInputSchema>;

export const CockpitRelayClarifyAnswersInputSchema = z
  .object({
    issue: IssueRefInputSchema,
    batch: z.number().int().min(0),
    answers: z
      .record(z.coerce.number().int().positive(), z.string().min(1))
      .refine((r) => Object.keys(r).length > 0, {
        message: 'answers map must contain at least one entry',
      }),
    actor: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, {
        message: 'actor must match /^[A-Za-z0-9-]+$/',
      })
      .optional(),
  })
  .strict();
export type CockpitRelayClarifyAnswersInput = z.infer<
  typeof CockpitRelayClarifyAnswersInputSchema
>;

/**
 * #1022 / #843 — remote-gate MCP-boundary schemas. Re-exported from
 * `./gates/schemas.ts` so the tool handlers (and the parity/audit tests)
 * consume a stable public-import surface. These are the SEMANTIC inputs: the
 * plugin passes semantic + presentation fields and `cockpit_gate_open` derives
 * gateKey/gateId and assembles the frozen `type:'gate-open'` record; the ack
 * input carries the closed `outcome` enum and the tool emits `gate-outcome`.
 * Both are flat `z.object`s so the MCP `inputSchema` has a `.shape`
 * (gen#1032/#1033). Wire contract: cockpit-remote-gates-plan.md § "Wire
 * contracts".
 */
export const CockpitGateOpenInputSchema = InternalGateOpenInputSchema;
export type CockpitGateOpenInput = z.infer<typeof CockpitGateOpenInputSchema>;

export const CockpitGateAckInputSchema = InternalGateAckInputSchema;
export type CockpitGateAckInput = z.infer<typeof CockpitGateAckInputSchema>;
