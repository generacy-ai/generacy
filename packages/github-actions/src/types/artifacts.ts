/**
 * Represents a workflow artifact
 */
export interface Artifact {
  /** Unique artifact ID */
  id: number;
  /** Node ID (GraphQL) */
  node_id: string;
  /** Artifact name */
  name: string;
  /** Size in bytes */
  size_in_bytes: number;
  /** Download URL */
  archive_download_url: string;
  /** Whether artifact has expired */
  expired: boolean;
  /** Created timestamp */
  created_at: string;
  /** Updated timestamp */
  updated_at: string;
  /** Expiration timestamp */
  expires_at: string;
  /** Workflow run ID that created this artifact */
  workflow_run?: {
    id: number;
    repository_id: number;
    head_repository_id: number;
    head_branch: string;
    head_sha: string;
  };
}

/**
 * Response from listing artifacts
 */
export interface ArtifactListResponse {
  /** Total count of artifacts */
  total_count: number;
  /** Array of artifacts */
  artifacts: Artifact[];
}

/**
 * Check if an artifact is still available for download
 */
export function isArtifactAvailable(artifact: Artifact): boolean {
  return !artifact.expired;
}

/**
 * Format artifact size for display
 */
export function formatArtifactSize(sizeInBytes: number): string {
  if (sizeInBytes < 1024) {
    return `${sizeInBytes} B`;
  }
  if (sizeInBytes < 1024 * 1024) {
    return `${(sizeInBytes / 1024).toFixed(2)} KB`;
  }
  if (sizeInBytes < 1024 * 1024 * 1024) {
    return `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
