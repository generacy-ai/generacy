import type { GitHubClient } from '../client.js';
import type { Label } from '../types/index.js';
import { GitHubValidationError } from '../utils/errors.js';

/**
 * Transform GitHub API label response to our Label type
 */
function transformLabel(apiLabel: {
  id: number;
  name: string;
  color: string;
  description: string | null;
}): Label {
  return {
    id: apiLabel.id,
    name: apiLabel.name,
    color: apiLabel.color,
    description: apiLabel.description,
  };
}

/**
 * Label operations using the GitHub client
 */
export class LabelOperations {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Add labels to an issue
   */
  async add(issueNumber: number, labels: string[]): Promise<Label[]> {
    if (labels.length === 0) {
      throw new GitHubValidationError('At least one label is required');
    }

    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.addLabels({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          labels,
        }),
      `add labels to issue #${issueNumber}`
    );

    return data.map(transformLabel);
  }

  /**
   * Remove a label from an issue
   */
  async remove(issueNumber: number, label: string): Promise<void> {
    await this.client.request(
      () =>
        this.client.rest.issues.removeLabel({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          name: label,
        }),
      `remove label '${label}' from issue #${issueNumber}`
    );
  }

  /**
   * Remove multiple labels from an issue
   */
  async removeMany(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }

    // GitHub API doesn't support bulk removal, so we remove one by one
    await Promise.all(
      labels.map((label) =>
        this.client.request(
          () =>
            this.client.rest.issues.removeLabel({
              owner: this.client.owner,
              repo: this.client.repo,
              issue_number: issueNumber,
              name: label,
            }),
          `remove label '${label}' from issue #${issueNumber}`
        ).catch((error) => {
          // Ignore 404 errors (label might not exist on the issue)
          if (error.code !== 'NOT_FOUND_ERROR') {
            throw error;
          }
        })
      )
    );
  }

  /**
   * Set labels on an issue (replaces all existing labels)
   */
  async set(issueNumber: number, labels: string[]): Promise<Label[]> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.setLabels({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          labels,
        }),
      `set labels on issue #${issueNumber}`
    );

    return data.map(transformLabel);
  }

  /**
   * List all labels on an issue
   */
  async list(issueNumber: number): Promise<Label[]> {
    const results = await this.client.paginate(
      (params) =>
        this.client.rest.issues.listLabelsOnIssue({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          ...params,
        }),
      5
    );

    return results.map(transformLabel);
  }

  /**
   * List all labels in the repository
   */
  async listForRepo(): Promise<Label[]> {
    const results = await this.client.paginate(
      (params) =>
        this.client.rest.issues.listLabelsForRepo({
          owner: this.client.owner,
          repo: this.client.repo,
          ...params,
        }),
      10
    );

    return results.map(transformLabel);
  }

  /**
   * Create a label in the repository
   */
  async create(name: string, color: string, description?: string): Promise<Label> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.createLabel({
          owner: this.client.owner,
          repo: this.client.repo,
          name,
          color: color.replace(/^#/, ''), // Remove # prefix if present
          description,
        }),
      `create label '${name}'`
    );

    return transformLabel(data);
  }

  /**
   * Delete a label from the repository
   */
  async delete(name: string): Promise<void> {
    await this.client.request(
      () =>
        this.client.rest.issues.deleteLabel({
          owner: this.client.owner,
          repo: this.client.repo,
          name,
        }),
      `delete label '${name}'`
    );
  }
}

/**
 * Create label operations instance
 */
export function createLabelOperations(client: GitHubClient): LabelOperations {
  return new LabelOperations(client);
}
