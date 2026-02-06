import type { GitHubClient } from '../client.js';
import type { Job, Step } from '../types/jobs.js';
import { JobNotFoundError, RunNotFoundError } from '../utils/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Map Octokit step response to our Step type
 */
function mapStep(step: any): Step {
  return {
    name: step.name ?? '',
    status: (step.status as Step['status']) ?? 'queued',
    conclusion: step.conclusion as Step['conclusion'],
    number: step.number ?? 0,
    started_at: step.started_at ?? null,
    completed_at: step.completed_at ?? null,
  };
}

/**
 * Map Octokit job response to our Job type
 */
function mapJob(job: any): Job {
  return {
    id: job.id,
    run_id: job.run_id,
    name: job.name ?? '',
    status: (job.status as Job['status']) ?? 'queued',
    conclusion: job.conclusion as Job['conclusion'],
    steps: (job.steps ?? []).map(mapStep),
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    runner_id: job.runner_id ?? null,
    runner_name: job.runner_name ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Get jobs for a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns Array of jobs
 */
export async function getJobs(
  client: GitHubClient,
  runId: number
): Promise<Job[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const response = await client.request((octokit) =>
      octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      })
    );

    return response.jobs.map(mapJob);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}

/**
 * Get a specific job by ID
 *
 * @param client - GitHub API client
 * @param jobId - Job ID
 * @returns The job
 */
export async function getJob(
  client: GitHubClient,
  jobId: number
): Promise<Job> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const job = await client.request((octokit) =>
      octokit.rest.actions.getJobForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      })
    );

    return mapJob(job);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new JobNotFoundError(jobId, error);
    }
    throw error;
  }
}

/**
 * Download job logs
 *
 * @param client - GitHub API client
 * @param jobId - Job ID
 * @returns Job logs as a string
 */
export async function getJobLogs(
  client: GitHubClient,
  jobId: number
): Promise<string> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const response = await client.requestRaw((octokit) =>
      octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      })
    );

    // The response is a redirect URL, we need to follow it
    if (typeof response === 'string') {
      return response;
    }

    // Handle ArrayBuffer or similar response
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as { data: unknown }).data;
      if (typeof data === 'string') {
        return data;
      }
      if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
      }
    }

    return String(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new JobNotFoundError(jobId, error);
    }
    throw error;
  }
}

/**
 * Get failed jobs from a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns Array of failed jobs
 */
export async function getFailedJobs(
  client: GitHubClient,
  runId: number
): Promise<Job[]> {
  const jobs = await getJobs(client, runId);
  return jobs.filter((job) => job.conclusion === 'failure');
}
