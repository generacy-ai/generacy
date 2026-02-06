/**
 * Check run status
 */
export type CheckStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Check run conclusion
 */
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

/**
 * Annotation level for check run annotations
 */
export type AnnotationLevel = 'notice' | 'warning' | 'failure';

/**
 * Check run annotation
 */
export interface CheckAnnotation {
  /** File path relative to repository root */
  path: string;
  /** Start line number */
  start_line: number;
  /** End line number */
  end_line: number;
  /** Start column (optional) */
  start_column?: number;
  /** End column (optional) */
  end_column?: number;
  /** Annotation level */
  annotation_level: AnnotationLevel;
  /** Annotation message */
  message: string;
  /** Annotation title (optional) */
  title?: string;
  /** Raw details (optional) */
  raw_details?: string;
}

/**
 * Check run output displayed in GitHub UI
 */
export interface CheckOutput {
  /** Output title */
  title: string;
  /** Output summary (supports markdown) */
  summary: string;
  /** Detailed text (optional, supports markdown) */
  text?: string;
  /** Annotations (optional, max 50) */
  annotations?: CheckAnnotation[];
}

/**
 * Represents a GitHub Check Run
 */
export interface CheckRun {
  /** Unique check run ID */
  id: number;
  /** Node ID (GraphQL) */
  node_id: string;
  /** Check name */
  name: string;
  /** HEAD SHA */
  head_sha: string;
  /** External ID for correlation */
  external_id?: string;
  /** Status */
  status: CheckStatus;
  /** Conclusion (when completed) */
  conclusion: CheckConclusion;
  /** Details URL */
  details_url?: string;
  /** HTML URL */
  html_url: string;
  /** Output displayed in GitHub UI */
  output?: {
    title: string | null;
    summary: string | null;
    text: string | null;
    annotations_count: number;
  };
  /** Started timestamp */
  started_at?: string;
  /** Completed timestamp */
  completed_at?: string;
}

/**
 * Parameters for creating a check run
 */
export interface CreateCheckRunParams {
  /** Check name */
  name: string;
  /** HEAD SHA to attach check to */
  head_sha: string;
  /** External ID for correlation */
  external_id?: string;
  /** Details URL */
  details_url?: string;
  /** Initial status */
  status?: CheckStatus;
  /** Initial output */
  output?: CheckOutput;
  /** Started timestamp (ISO 8601) */
  started_at?: string;
}

/**
 * Parameters for updating a check run
 */
export interface UpdateCheckRunParams {
  /** Updated status */
  status?: CheckStatus;
  /** Conclusion (required when status is 'completed') */
  conclusion?: CheckConclusion;
  /** Updated output */
  output?: CheckOutput;
  /** Completion timestamp (ISO 8601) */
  completed_at?: string;
}

/**
 * Check if a check run is complete
 */
export function isCheckComplete(check: CheckRun): boolean {
  return check.status === 'completed';
}

/**
 * Check if a check run was successful
 */
export function isCheckSuccessful(check: CheckRun): boolean {
  return check.status === 'completed' && check.conclusion === 'success';
}
