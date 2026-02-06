import type { GitHubClient } from '../client.js';
import type {
  CheckRun,
  CreateCheckRunParams,
  UpdateCheckRunParams,
} from '../types/check-runs.js';
import { CheckRunNotFoundError } from '../utils/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Map Octokit check run response to our CheckRun type
 */
function mapCheckRun(check: any): CheckRun {
  return {
    id: check.id,
    node_id: check.node_id ?? '',
    name: check.name ?? '',
    head_sha: check.head_sha ?? '',
    external_id: check.external_id ?? undefined,
    status: (check.status as CheckRun['status']) ?? 'queued',
    conclusion: check.conclusion as CheckRun['conclusion'],
    details_url: check.details_url ?? undefined,
    html_url: check.html_url ?? '',
    output: check.output
      ? {
          title: check.output.title,
          summary: check.output.summary,
          text: check.output.text,
          annotations_count: check.output.annotations_count ?? 0,
        }
      : undefined,
    started_at: check.started_at ?? undefined,
    completed_at: check.completed_at ?? undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Create a new check run
 *
 * @param client - GitHub API client
 * @param params - Check run creation parameters
 * @returns The created check run
 */
export async function createCheckRun(
  client: GitHubClient,
  params: CreateCheckRunParams
): Promise<CheckRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const check = await client.request((octokit) =>
    octokit.rest.checks.create({
      owner,
      repo,
      name: params.name,
      head_sha: params.head_sha,
      external_id: params.external_id,
      details_url: params.details_url,
      status: params.status,
      output: params.output
        ? {
            title: params.output.title,
            summary: params.output.summary,
            text: params.output.text,
            annotations: params.output.annotations?.map((a) => ({
              path: a.path,
              start_line: a.start_line,
              end_line: a.end_line,
              start_column: a.start_column,
              end_column: a.end_column,
              annotation_level: a.annotation_level,
              message: a.message,
              title: a.title,
              raw_details: a.raw_details,
            })),
          }
        : undefined,
      started_at: params.started_at,
    })
  );

  return mapCheckRun(check);
}

/**
 * Update an existing check run
 *
 * @param client - GitHub API client
 * @param checkRunId - Check run ID
 * @param params - Check run update parameters
 * @returns The updated check run
 */
export async function updateCheckRun(
  client: GitHubClient,
  checkRunId: number,
  params: UpdateCheckRunParams
): Promise<CheckRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const check = await client.request((octokit) =>
      octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        status: params.status,
        conclusion: params.conclusion ?? undefined,
        output: params.output
          ? {
              title: params.output.title,
              summary: params.output.summary,
              text: params.output.text,
              annotations: params.output.annotations?.map((a) => ({
                path: a.path,
                start_line: a.start_line,
                end_line: a.end_line,
                start_column: a.start_column,
                end_column: a.end_column,
                annotation_level: a.annotation_level,
                message: a.message,
                title: a.title,
                raw_details: a.raw_details,
              })),
            }
          : undefined,
        completed_at: params.completed_at,
      })
    );

    return mapCheckRun(check);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new CheckRunNotFoundError(checkRunId, error);
    }
    throw error;
  }
}

/**
 * Get a check run by ID
 *
 * @param client - GitHub API client
 * @param checkRunId - Check run ID
 * @returns The check run
 */
export async function getCheckRun(
  client: GitHubClient,
  checkRunId: number
): Promise<CheckRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const check = await client.request((octokit) =>
      octokit.rest.checks.get({
        owner,
        repo,
        check_run_id: checkRunId,
      })
    );

    return mapCheckRun(check);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new CheckRunNotFoundError(checkRunId, error);
    }
    throw error;
  }
}

/**
 * List check runs for a Git reference
 *
 * @param client - GitHub API client
 * @param ref - Git ref (SHA, branch name, or tag name)
 * @param options - List options
 * @returns Array of check runs
 */
export async function listCheckRuns(
  client: GitHubClient,
  ref: string,
  options?: {
    check_name?: string;
    status?: 'queued' | 'in_progress' | 'completed';
    filter?: 'latest' | 'all';
    per_page?: number;
    page?: number;
  }
): Promise<CheckRun[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const response = await client.request((octokit) =>
    octokit.rest.checks.listForRef({
      owner,
      repo,
      ref,
      check_name: options?.check_name,
      status: options?.status,
      filter: options?.filter,
      per_page: options?.per_page ?? 30,
      page: options?.page ?? 1,
    })
  );

  return response.check_runs.map(mapCheckRun);
}

/**
 * List check runs for a check suite
 *
 * @param client - GitHub API client
 * @param checkSuiteId - Check suite ID
 * @param options - List options
 * @returns Array of check runs
 */
export async function listCheckRunsForSuite(
  client: GitHubClient,
  checkSuiteId: number,
  options?: {
    check_name?: string;
    status?: 'queued' | 'in_progress' | 'completed';
    filter?: 'latest' | 'all';
    per_page?: number;
    page?: number;
  }
): Promise<CheckRun[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const response = await client.request((octokit) =>
    octokit.rest.checks.listForSuite({
      owner,
      repo,
      check_suite_id: checkSuiteId,
      check_name: options?.check_name,
      status: options?.status,
      filter: options?.filter,
      per_page: options?.per_page ?? 30,
      page: options?.page ?? 1,
    })
  );

  return response.check_runs.map(mapCheckRun);
}
