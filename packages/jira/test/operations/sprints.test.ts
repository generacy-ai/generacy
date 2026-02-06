import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintOperations, createSprintOperations } from '../../src/operations/sprints.js';
import { JiraClient } from '../../src/client.js';
import { JiraNotFoundError } from '../../src/utils/errors.js';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

const mockSprint = {
  id: 1,
  self: 'https://company.atlassian.net/rest/agile/1.0/sprint/1',
  state: 'active',
  name: 'Sprint 1',
  startDate: '2024-01-15T00:00:00.000Z',
  endDate: '2024-01-29T00:00:00.000Z',
  completeDate: null,
  originBoardId: 1,
  goal: 'Complete authentication features',
};

const mockBoard = {
  id: 1,
  self: 'https://company.atlassian.net/rest/agile/1.0/board/1',
  name: 'PROJ board',
  type: 'scrum',
  location: {
    projectId: 10000,
    projectKey: 'PROJ',
    projectName: 'My Project',
  },
};

describe('SprintOperations', () => {
  let mockClient: {
    agile: {
      board: {
        getAllSprints: ReturnType<typeof vi.fn>;
        getAllBoards: ReturnType<typeof vi.fn>;
        getBoard: ReturnType<typeof vi.fn>;
      };
      sprint: {
        getSprint: ReturnType<typeof vi.fn>;
        moveIssuesToSprintAndRank: ReturnType<typeof vi.fn>;
        getIssuesForSprint: ReturnType<typeof vi.fn>;
      };
      backlog: {
        moveIssuesToBacklog: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: SprintOperations;

  beforeEach(() => {
    mockClient = {
      agile: {
        board: {
          getAllSprints: vi.fn(),
          getAllBoards: vi.fn(),
          getBoard: vi.fn(),
        },
        sprint: {
          getSprint: vi.fn(),
          moveIssuesToSprintAndRank: vi.fn(),
          getIssuesForSprint: vi.fn(),
        },
        backlog: {
          moveIssuesToBacklog: vi.fn(),
        },
      },
    };
    operations = createSprintOperations(mockClient as unknown as JiraClient);
  });

  describe('getActiveSprint', () => {
    it('should get the active sprint for a board', async () => {
      mockClient.agile.board.getAllSprints.mockResolvedValue({
        values: [mockSprint],
      });

      const sprint = await operations.getActiveSprint(1);

      expect(mockClient.agile.board.getAllSprints).toHaveBeenCalledWith({
        boardId: 1,
        state: 'active',
      });
      expect(sprint).not.toBeNull();
      expect(sprint?.name).toBe('Sprint 1');
      expect(sprint?.state).toBe('active');
    });

    it('should return null when no active sprint', async () => {
      mockClient.agile.board.getAllSprints.mockResolvedValue({
        values: [],
      });

      const sprint = await operations.getActiveSprint(1);

      expect(sprint).toBeNull();
    });
  });

  describe('getSprintsForBoard', () => {
    it('should get all sprints for a board', async () => {
      mockClient.agile.board.getAllSprints.mockResolvedValue({
        values: [
          mockSprint,
          { ...mockSprint, id: 2, name: 'Sprint 2', state: 'future' },
        ],
      });

      const sprints = await operations.getSprintsForBoard(1);

      expect(mockClient.agile.board.getAllSprints).toHaveBeenCalledWith({
        boardId: 1,
        state: undefined,
      });
      expect(sprints).toHaveLength(2);
    });

    it('should filter by state', async () => {
      mockClient.agile.board.getAllSprints.mockResolvedValue({
        values: [mockSprint],
      });

      await operations.getSprintsForBoard(1, 'active');

      expect(mockClient.agile.board.getAllSprints).toHaveBeenCalledWith({
        boardId: 1,
        state: 'active',
      });
    });
  });

  describe('getSprint', () => {
    it('should get a sprint by ID', async () => {
      mockClient.agile.sprint.getSprint.mockResolvedValue(mockSprint);

      const sprint = await operations.getSprint(1);

      expect(mockClient.agile.sprint.getSprint).toHaveBeenCalledWith({
        sprintId: 1,
      });
      expect(sprint.name).toBe('Sprint 1');
    });

    it('should throw JiraNotFoundError for non-existent sprint', async () => {
      mockClient.agile.sprint.getSprint.mockRejectedValue({ status: 404 });

      await expect(operations.getSprint(999)).rejects.toThrow(JiraNotFoundError);
    });
  });

  describe('addIssueToSprint', () => {
    it('should add an issue to a sprint with separate arguments', async () => {
      mockClient.agile.sprint.moveIssuesToSprintAndRank.mockResolvedValue(undefined);

      await operations.addIssueToSprint('PROJ-123', 1);

      expect(mockClient.agile.sprint.moveIssuesToSprintAndRank).toHaveBeenCalledWith({
        sprintId: 1,
        issues: ['PROJ-123'],
      });
    });

    it('should add an issue to a sprint with params object', async () => {
      mockClient.agile.sprint.moveIssuesToSprintAndRank.mockResolvedValue(undefined);

      await operations.addIssueToSprint({
        issueKey: 'PROJ-123',
        sprintId: 1,
      });

      expect(mockClient.agile.sprint.moveIssuesToSprintAndRank).toHaveBeenCalledWith({
        sprintId: 1,
        issues: ['PROJ-123'],
      });
    });
  });

  describe('addIssuesToSprint', () => {
    it('should add multiple issues to a sprint', async () => {
      mockClient.agile.sprint.moveIssuesToSprintAndRank.mockResolvedValue(undefined);

      await operations.addIssuesToSprint(['PROJ-123', 'PROJ-124', 'PROJ-125'], 1);

      expect(mockClient.agile.sprint.moveIssuesToSprintAndRank).toHaveBeenCalledWith({
        sprintId: 1,
        issues: ['PROJ-123', 'PROJ-124', 'PROJ-125'],
      });
    });
  });

  describe('removeFromSprint', () => {
    it('should remove an issue from its sprint', async () => {
      mockClient.agile.backlog.moveIssuesToBacklog.mockResolvedValue(undefined);

      await operations.removeFromSprint('PROJ-123');

      expect(mockClient.agile.backlog.moveIssuesToBacklog).toHaveBeenCalledWith({
        issues: ['PROJ-123'],
      });
    });
  });

  describe('getIssuesInSprint', () => {
    it('should get all issue keys in a sprint', async () => {
      mockClient.agile.sprint.getIssuesForSprint.mockResolvedValue({
        issues: [
          { key: 'PROJ-123' },
          { key: 'PROJ-124' },
        ],
      });

      const keys = await operations.getIssuesInSprint(1);

      expect(mockClient.agile.sprint.getIssuesForSprint).toHaveBeenCalledWith({
        sprintId: 1,
        fields: ['key'],
      });
      expect(keys).toEqual(['PROJ-123', 'PROJ-124']);
    });
  });

  describe('getBoardsForProject', () => {
    it('should get all boards for a project', async () => {
      mockClient.agile.board.getAllBoards.mockResolvedValue({
        values: [mockBoard],
      });

      const boards = await operations.getBoardsForProject('PROJ');

      expect(mockClient.agile.board.getAllBoards).toHaveBeenCalledWith({
        projectKeyOrId: 'PROJ',
      });
      expect(boards).toHaveLength(1);
      expect(boards[0]?.name).toBe('PROJ board');
    });
  });

  describe('getBoard', () => {
    it('should get a board by ID', async () => {
      mockClient.agile.board.getBoard.mockResolvedValue(mockBoard);

      const board = await operations.getBoard(1);

      expect(mockClient.agile.board.getBoard).toHaveBeenCalledWith({
        boardId: 1,
      });
      expect(board.name).toBe('PROJ board');
      expect(board.type).toBe('scrum');
    });

    it('should throw JiraNotFoundError for non-existent board', async () => {
      mockClient.agile.board.getBoard.mockRejectedValue({ status: 404 });

      await expect(operations.getBoard(999)).rejects.toThrow(JiraNotFoundError);
    });
  });
});
