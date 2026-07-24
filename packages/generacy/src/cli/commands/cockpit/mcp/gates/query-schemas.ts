/**
 * Zod schemas for the two remote-gate **read-only** query MCP tools (#1038).
 *
 * These sit next to `./schemas.ts` (which owns the write-path schemas) but
 * are in a separate file so the observer-independence import-scan can prove
 * that the query tools do not touch the write path. Keep the two files
 * import-disjoint.
 *
 * Wire contract: specs/1038-issue-1038/contracts/gate-query.md § response
 * envelopes. The **orchestrator route** performs the seven-to-three cloud
 * status collapse; the MCP boundary sees only `open | answered | absent`.
 */
import { z } from 'zod';
import { GateTypeSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// `cockpit_gate_status` — status-mode query
// ---------------------------------------------------------------------------

export const CockpitGateStatusInputSchema = z
  .object({
    /** owner/repo#N — the gate's issue reference. */
    issueRef: z.string().min(1),
    /** 8-value gate-type enum (same as the write path). */
    gateType: GateTypeSchema,
    /** gateType-specific discriminator (batchId hash, head SHA, phase, ...). */
    generation: z.union([z.string().min(1), z.number()]),
  })
  .strict();
export type CockpitGateStatusInput = z.infer<typeof CockpitGateStatusInputSchema>;

/**
 * Three-state MCP-facing status. `open` and `answered` carry a real gateId;
 * `absent` is the load-bearing "not here" signal (FR-013) — the sweep is
 * free to draft under this discriminator.
 */
export const CockpitGateStatusDataSchema = z.union([
  z.object({
    gateId: z.string().length(24),
    status: z.enum(['open', 'answered']),
  }),
  z.object({
    gateId: z.null(),
    status: z.literal('absent'),
  }),
]);
export type CockpitGateStatusData = z.infer<typeof CockpitGateStatusDataSchema>;

// ---------------------------------------------------------------------------
// `cockpit_gate_list` — list-mode query
// ---------------------------------------------------------------------------

export const CockpitGateListInputSchema = z
  .object({
    issueRef: z.string().min(1),
    /** Optional — narrow to a single gateType. Absent = all types. */
    gateType: GateTypeSchema.optional(),
  })
  .strict();
export type CockpitGateListInput = z.infer<typeof CockpitGateListInputSchema>;

export const CockpitGateListEntrySchema = z.object({
  gateId: z.string().length(24),
  gateType: GateTypeSchema,
  /** Always emitted as a string — numeric batchIds are coerced upstream. */
  generation: z.string().min(1),
  status: z.enum(['open', 'answered']),
});
export type CockpitGateListEntry = z.infer<typeof CockpitGateListEntrySchema>;

export const CockpitGateListDataSchema = z.object({
  gates: z.array(CockpitGateListEntrySchema),
  /**
   * Set to `true` only when the cloud upstream paginates and this call did
   * not fetch further pages. Absent (not `false`) means the list is complete.
   */
  truncated: z.boolean().optional(),
});
export type CockpitGateListData = z.infer<typeof CockpitGateListDataSchema>;
