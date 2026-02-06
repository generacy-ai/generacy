import type { JiraClient } from '../client.js';
import type { Sprint, SprintState, AddToSprintParams } from '../types/sprints.js';
import type { Board } from '../types/projects.js';
import { ensureIssueKey } from '../utils/validation.js';
import { wrapJiraError, JiraNotFoundError } from '../utils/errors.js';

/**
 * Map API response to Sprint
 */
function mapSprint(raw: Record<string, unknown>): Sprint {
  return {
    id: raw.id as number,
    self: raw.self as string,
    state: raw.state as SprintState,
    name: raw.name as string,
    startDate: (raw.startDate as string) ?? null,
    endDate: (raw.endDate as string) ?? null,
    completeDate: (raw.completeDate as string) ?? null,
    originBoardId: raw.originBoardId as number,
    goal: (raw.goal as string) ?? null,
  };
}

/**
 * Map API response to Board
 */
function mapBoard(raw: Record<string, unknown>): Board {
  return {
    id: raw.id as number,
    self: raw.self as string,
    name: raw.name as string,
    type: raw.type as 'scrum' | 'kanban' | 'simple',
    location: raw.location as Board['location'],
  };
}

/**
 * Sprint operations (requires Agile API)
 */
export class SprintOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Get the active sprint for a board
   */
  async getActiveSprint(boardId: number): Promise<Sprint | null> {
    try {
      const response = await this.client.agile.board.getAllSprints({
        boardId,
        state: 'active',
      });
      const sprints = response.values ?? [];
      if (sprints.length === 0) {
        return null;
      }
      return mapSprint(sprints[0] as unknown as Record<string, unknown>);
    } catch (error) {
      throw wrapJiraError(error, `Failed to get active sprint for board ${boardId}`);
    }
  }

  /**
   * Get all sprints for a board
   */
  async getSprintsForBoard(boardId: number, state?: SprintState): Promise<Sprint[]> {
    try {
      const response = await this.client.agile.board.getAllSprints({
        boardId,
        state,
      });
      const sprints = response.values ?? [];
      return sprints.map((s) => mapSprint(s as unknown as Record<string, unknown>));
    } catch (error) {
      throw wrapJiraError(error, `Failed to get sprints for board ${boardId}`);
    }
  }

  /**
   * Get a sprint by ID
   */
  async getSprint(sprintId: number): Promise<Sprint> {
    try {
      const response = await this.client.agile.sprint.getSprint({
        sprintId,
      });
      return mapSprint(response as unknown as Record<string, unknown>);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) {
        throw new JiraNotFoundError('Sprint', sprintId.toString(), error);
      }
      throw wrapJiraError(error, `Failed to get sprint ${sprintId}`);
    }
  }

  /**
   * Add an issue to a sprint
   */
  async addIssueToSprint(issueKey: string, sprintId: number): Promise<void>;
  async addIssueToSprint(params: AddToSprintParams): Promise<void>;
  async addIssueToSprint(issueKeyOrParams: string | AddToSprintParams, sprintId?: number): Promise<void> {
    let key: string;
    let sprint: number;

    if (typeof issueKeyOrParams === 'string') {
      key = ensureIssueKey(issueKeyOrParams);
      sprint = sprintId!;
    } else {
      key = ensureIssueKey(issueKeyOrParams.issueKey);
      sprint = issueKeyOrParams.sprintId;
    }

    try {
      await this.client.agile.sprint.moveIssuesToSprintAndRank({
        sprintId: sprint,
        issues: [key],
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to add ${key} to sprint ${sprint}`);
    }
  }

  /**
   * Add multiple issues to a sprint
   */
  async addIssuesToSprint(issueKeys: string[], sprintId: number): Promise<void> {
    const keys = issueKeys.map(ensureIssueKey);

    try {
      await this.client.agile.sprint.moveIssuesToSprintAndRank({
        sprintId,
        issues: keys,
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to add issues to sprint ${sprintId}`);
    }
  }

  /**
   * Remove an issue from its current sprint (move to backlog)
   */
  async removeFromSprint(issueKey: string): Promise<void> {
    const key = ensureIssueKey(issueKey);

    try {
      await this.client.agile.backlog.moveIssuesToBacklog({
        issues: [key],
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to remove ${key} from sprint`);
    }
  }

  /**
   * Get issues in a sprint
   */
  async getIssuesInSprint(sprintId: number, options?: { fields?: string[] }): Promise<string[]> {
    try {
      const response = await this.client.agile.sprint.getIssuesForSprint({
        sprintId,
        fields: options?.fields ?? ['key'],
      });
      const issues = (response.issues ?? []) as Array<{ key: string }>;
      return issues.map((i) => i.key);
    } catch (error) {
      throw wrapJiraError(error, `Failed to get issues for sprint ${sprintId}`);
    }
  }

  /**
   * Get all boards for a project
   */
  async getBoardsForProject(projectKey: string): Promise<Board[]> {
    try {
      const response = await this.client.agile.board.getAllBoards({
        projectKeyOrId: projectKey,
      });
      const boards = (response.values ?? []) as Array<Record<string, unknown>>;
      return boards.map(mapBoard);
    } catch (error) {
      throw wrapJiraError(error, `Failed to get boards for project ${projectKey}`);
    }
  }

  /**
   * Get a board by ID
   */
  async getBoard(boardId: number): Promise<Board> {
    try {
      const response = await this.client.agile.board.getBoard({
        boardId,
      });
      return mapBoard(response as unknown as Record<string, unknown>);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) {
        throw new JiraNotFoundError('Board', boardId.toString(), error);
      }
      throw wrapJiraError(error, `Failed to get board ${boardId}`);
    }
  }
}

/**
 * Create sprint operations instance
 */
export function createSprintOperations(client: JiraClient): SprintOperations {
  return new SprintOperations(client);
}
