/**
 * Lineage-map value type for `LabelManager.provisioningFailures`.
 *
 * Populated by the error branch of `ensureRepoLabelsExist`'s classification;
 * read by `addLabels` when an apply-time 404 references a `WORKFLOW_LABELS`
 * name. Enrichment splices `cause` and `statusCode` into the thrown error's
 * message so the operator sees the provisioning cause inline.
 */
export interface ProvisioningError {
  readonly cause: string;
  readonly statusCode?: number;
  readonly classifiedAt: number;
}
