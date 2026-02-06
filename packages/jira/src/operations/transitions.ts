import type { JiraClient } from '../client.js';
import type { Transition, TransitionParams, JiraStatus, TransitionField } from '../types/workflows.js';
import { ensureIssueKey } from '../utils/validation.js';
import { wrapJiraError, JiraTransitionError, JiraNotFoundError } from '../utils/errors.js';
import { ensureAdf } from '../utils/adf.js';

/**
 * Map API response to Transition
 */
function mapTransition(raw: Record<string, unknown>): Transition {
  return {
    id: raw.id as string,
    name: raw.name as string,
    to: raw.to as JiraStatus,
    hasScreen: (raw.hasScreen as boolean) ?? false,
    isGlobal: (raw.isGlobal as boolean) ?? false,
    isInitial: (raw.isInitial as boolean) ?? false,
    isConditional: (raw.isConditional as boolean) ?? false,
    fields: raw.fields as Record<string, TransitionField> | undefined,
  };
}

/**
 * Transition (workflow) operations
 */
export class TransitionOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Get available transitions for an issue
   */
  async getTransitions(issueKey: string): Promise<Transition[]> {
    const key = ensureIssueKey(issueKey);

    try {
      const response = await this.client.v3.issues.getTransitions({
        issueIdOrKey: key,
        expand: 'transitions.fields',
      });
      return (response.transitions ?? []).map((t) => mapTransition(t as unknown as Record<string, unknown>));
    } catch (error) {
      throw wrapJiraError(error, `Failed to get transitions for ${key}`);
    }
  }

  /**
   * Execute a transition on an issue
   */
  async transition(issueKey: string, transitionId: string, options?: { fields?: Record<string, unknown>; comment?: string }): Promise<void>;
  async transition(issueKey: string, params: TransitionParams): Promise<void>;
  async transition(issueKey: string, transitionIdOrParams: string | TransitionParams, options?: { fields?: Record<string, unknown>; comment?: string }): Promise<void> {
    const key = ensureIssueKey(issueKey);

    let transitionId: string;
    let fields: Record<string, unknown> | undefined;
    let comment: string | undefined;

    if (typeof transitionIdOrParams === 'string') {
      transitionId = transitionIdOrParams;
      fields = options?.fields;
      comment = options?.comment;
    } else {
      transitionId = transitionIdOrParams.transitionId;
      fields = transitionIdOrParams.fields;
      comment = transitionIdOrParams.comment;
    }

    try {
      const requestBody: {
        transition: { id: string };
        fields?: Record<string, unknown>;
        update?: { comment?: Array<{ add: { body: unknown } }> };
      } = {
        transition: { id: transitionId },
      };

      if (fields) {
        requestBody.fields = fields;
      }

      if (comment) {
        requestBody.update = {
          comment: [{ add: { body: ensureAdf(comment) } }],
        };
      }

      await this.client.v3.issues.doTransition({
        issueIdOrKey: key,
        ...requestBody,
      });
    } catch (error) {
      // If transition failed, provide helpful error with available transitions
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = (error as { status: number }).status;
        if (status === 400 || status === 422) {
          const available = await this.getTransitions(key);
          throw new JiraTransitionError(
            `Transition '${transitionId}' is not available for issue ${key}`,
            available,
            error
          );
        }
      }
      throw wrapJiraError(error, `Failed to transition ${key}`);
    }
  }

  /**
   * Transition an issue by target status name
   */
  async transitionToStatus(issueKey: string, targetStatusName: string, options?: { fields?: Record<string, unknown>; comment?: string }): Promise<void> {
    const key = ensureIssueKey(issueKey);
    const transitions = await this.getTransitions(key);

    // Find transition that leads to the target status
    const transition = transitions.find(
      (t) => t.to.name.toLowerCase() === targetStatusName.toLowerCase()
    );

    if (!transition) {
      throw new JiraTransitionError(
        `No transition available to status '${targetStatusName}' for issue ${key}`,
        transitions
      );
    }

    await this.transition(key, transition.id, options);
  }

  /**
   * Get the current status of an issue
   */
  async getStatus(issueKey: string): Promise<JiraStatus> {
    const key = ensureIssueKey(issueKey);

    try {
      const response = await this.client.v3.issues.getIssue({
        issueIdOrKey: key,
        fields: ['status'],
      });
      const fields = response.fields as Record<string, unknown>;
      return fields.status as JiraStatus;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) {
        throw new JiraNotFoundError('Issue', key, error);
      }
      throw wrapJiraError(error, `Failed to get status for ${key}`);
    }
  }

  /**
   * Check if a transition is available for an issue
   */
  async isTransitionAvailable(issueKey: string, transitionName: string): Promise<boolean> {
    const transitions = await this.getTransitions(issueKey);
    return transitions.some(
      (t) => t.name.toLowerCase() === transitionName.toLowerCase() ||
             t.to.name.toLowerCase() === transitionName.toLowerCase()
    );
  }
}

/**
 * Create transition operations instance
 */
export function createTransitionOperations(client: JiraClient): TransitionOperations {
  return new TransitionOperations(client);
}
