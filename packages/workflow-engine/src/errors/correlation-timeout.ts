/**
 * Thrown when a decision request times out waiting for a human response.
 * Checked by name in HumancyReviewAction to produce a timeout failure result.
 */
export class CorrelationTimeoutError extends Error {
  public readonly decisionId?: string;

  constructor(message: string, decisionId?: string) {
    super(message);
    this.name = 'CorrelationTimeoutError';
    this.decisionId = decisionId;
  }
}
