import { z } from 'zod';

/**
 * Object form of an issue reference. This is a cluster-local convenience shape
 * used by the gate-generation helpers (`deriveScopeDrainedGeneration`) and by
 * MCP callers before they format it to the flat `owner/repo#N` wire string.
 *
 * The WIRE shapes in `./schema.ts` carry `issueRef` / `epicRef` as plain
 * strings (Shapes 1/3, mirroring the cloud); this object shape never crosses
 * the wire. Format it with {@link issueRefToString} before calling
 * `deriveGateKey`.
 */
export const IssueRefSchema = z.object({
  owner: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  repo: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  number: z.number().int().positive(),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

/** Format an object {@link IssueRef} to the canonical `owner/repo#N` wire ref. */
export function issueRefToString(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
