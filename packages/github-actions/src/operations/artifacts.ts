import type { GitHubClient } from '../client.js';
import type { Artifact } from '../types/artifacts.js';
import { ArtifactNotFoundError, RunNotFoundError } from '../utils/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Map Octokit artifact response to our Artifact type
 */
function mapArtifact(artifact: any): Artifact {
  const workflowRun = artifact.workflow_run;
  return {
    id: artifact.id,
    node_id: artifact.node_id,
    name: artifact.name,
    size_in_bytes: artifact.size_in_bytes,
    archive_download_url: artifact.archive_download_url,
    expired: artifact.expired,
    created_at: artifact.created_at ?? '',
    updated_at: artifact.updated_at ?? '',
    expires_at: artifact.expires_at ?? '',
    workflow_run: workflowRun ? {
      id: workflowRun.id ?? 0,
      repository_id: workflowRun.repository_id ?? 0,
      head_repository_id: workflowRun.head_repository_id ?? 0,
      head_branch: workflowRun.head_branch ?? '',
      head_sha: workflowRun.head_sha ?? '',
    } : undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * List artifacts for a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns Array of artifacts
 */
export async function listArtifacts(
  client: GitHubClient,
  runId: number
): Promise<Artifact[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const response = await client.request((octokit) =>
      octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
      })
    );

    return response.artifacts.map(mapArtifact);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}

/**
 * Get a specific artifact by ID
 *
 * @param client - GitHub API client
 * @param artifactId - Artifact ID
 * @returns The artifact
 */
export async function getArtifact(
  client: GitHubClient,
  artifactId: number
): Promise<Artifact> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const artifact = await client.request((octokit) =>
      octokit.rest.actions.getArtifact({
        owner,
        repo,
        artifact_id: artifactId,
      })
    );

    return mapArtifact(artifact);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new ArtifactNotFoundError(artifactId, error);
    }
    throw error;
  }
}

/**
 * Download an artifact
 *
 * @param client - GitHub API client
 * @param artifactId - Artifact ID
 * @returns Artifact content as a Buffer
 */
export async function downloadArtifact(
  client: GitHubClient,
  artifactId: number
): Promise<Buffer> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const response = await client.requestRaw((octokit) =>
      octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
        archive_format: 'zip',
      })
    );

    // Handle different response types
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as { data: unknown }).data;
      if (Buffer.isBuffer(data)) {
        return data;
      }
      if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
      }
      if (typeof data === 'string') {
        return Buffer.from(data);
      }
    }

    // Fallback: convert to buffer if possible
    if (Buffer.isBuffer(response)) {
      return response;
    }
    if (response instanceof ArrayBuffer) {
      return Buffer.from(response);
    }

    throw new Error('Unexpected response format from artifact download');
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new ArtifactNotFoundError(artifactId, error);
    }
    throw error;
  }
}

/**
 * Delete an artifact
 *
 * @param client - GitHub API client
 * @param artifactId - Artifact ID
 */
export async function deleteArtifact(
  client: GitHubClient,
  artifactId: number
): Promise<void> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    await client.request((octokit) =>
      octokit.rest.actions.deleteArtifact({
        owner,
        repo,
        artifact_id: artifactId,
      })
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new ArtifactNotFoundError(artifactId, error);
    }
    throw error;
  }
}

/**
 * List all artifacts in a repository
 *
 * @param client - GitHub API client
 * @param options - List options
 * @returns Array of artifacts
 */
export async function listRepoArtifacts(
  client: GitHubClient,
  options?: {
    per_page?: number;
    page?: number;
    name?: string;
  }
): Promise<Artifact[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const response = await client.request((octokit) =>
    octokit.rest.actions.listArtifactsForRepo({
      owner,
      repo,
      per_page: options?.per_page ?? 30,
      page: options?.page ?? 1,
      name: options?.name,
    })
  );

  return response.artifacts.map(mapArtifact);
}
