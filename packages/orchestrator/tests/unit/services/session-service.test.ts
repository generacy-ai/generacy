import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { SessionService } from '../../../src/services/session-service.js';

const fixturesDir = path.resolve(__dirname, '../../fixtures/sessions');
const workspaceDir = path.join(fixturesDir, '-workspaces-generacy');

describe('SessionService', () => {
  let service: SessionService;

  beforeAll(() => {
    service = new SessionService({
      claudeProjectsDir: fixturesDir,
      workspaces: { main: '/workspaces/generacy' },
    });
  });

  describe('discoverDirectories', () => {
    it('should find directories under the projects dir', async () => {
      const dirs = await service.discoverDirectories();
      expect(dirs.length).toBeGreaterThanOrEqual(1);
      expect(dirs.some((d) => d.endsWith('-workspaces-generacy'))).toBe(true);
    });

    it('should return empty array for missing directory', async () => {
      const dirs = await service.discoverDirectories('/nonexistent/path');
      expect(dirs).toEqual([]);
    });
  });

  describe('parseSessionFile', () => {
    it('should extract metadata from a normal session', async () => {
      const file = path.join(workspaceDir, '11111111-1111-1111-1111-111111111111.jsonl');
      const result = await service.parseSessionFile(file, '/workspaces/generacy');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('11111111-1111-1111-1111-111111111111');
      expect(result!.slug).toBe('help-with-code');
      expect(result!.startedAt).toBe('2026-03-10T10:00:00.000Z');
      expect(result!.lastActivityAt).toBe('2026-03-10T10:00:15.000Z');
      expect(result!.messageCount).toBe(4); // 2 user + 2 assistant
      expect(result!.model).toBe('claude-sonnet-4-20250514');
      expect(result!.gitBranch).toBe('main');
      expect(result!.type).toBe('developer');
      expect(result!.workspace).toBe('/workspaces/generacy');
    });

    it('should detect automated sessions via bypassPermissions', async () => {
      const file = path.join(workspaceDir, '22222222-2222-2222-2222-222222222222.jsonl');
      const result = await service.parseSessionFile(file, '/workspaces/generacy');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('automated');
      expect(result!.gitBranch).toBe('feature-branch');
    });

    it('should handle session with missing optional fields', async () => {
      const file = path.join(workspaceDir, '33333333-3333-3333-3333-333333333333.jsonl');
      const result = await service.parseSessionFile(file, '/workspaces/generacy');

      expect(result).not.toBeNull();
      expect(result!.model).toBeNull();
      expect(result!.gitBranch).toBeNull();
      expect(result!.slug).toBeNull();
      expect(result!.type).toBe('developer');
    });

    it('should handle files with malformed JSON lines', async () => {
      const file = path.join(workspaceDir, '44444444-4444-4444-4444-444444444444.jsonl');
      const result = await service.parseSessionFile(file, '/workspaces/generacy');

      expect(result).not.toBeNull();
      expect(result!.messageCount).toBe(2); // 1 user + 1 assistant (malformed lines skipped)
    });

    it('should return null for empty files', async () => {
      const file = path.join(workspaceDir, 'empty-session.jsonl');
      const result = await service.parseSessionFile(file, '/workspaces/generacy');
      // empty-session.jsonl doesn't have UUID filename so it returns null
      expect(result).toBeNull();
    });

    it('should return null for non-UUID filenames', async () => {
      const file = path.join(workspaceDir, 'empty-session.jsonl');
      const result = await service.parseSessionFile(file, null);
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should return paginated sessions sorted by lastActivityAt desc', async () => {
      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result.sessions.length).toBeGreaterThanOrEqual(3);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(20);

      // Check sorted descending by lastActivityAt
      for (let i = 1; i < result.sessions.length; i++) {
        expect(
          new Date(result.sessions[i - 1].lastActivityAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(result.sessions[i].lastActivityAt).getTime());
      }
    });

    it('should paginate correctly', async () => {
      const result = await service.list({ page: 1, pageSize: 2 });

      expect(result.sessions.length).toBe(2);
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.total).toBeGreaterThan(2);

      const page2 = await service.list({ page: 2, pageSize: 2 });
      expect(page2.sessions.length).toBeGreaterThanOrEqual(1);
      expect(page2.pagination.page).toBe(2);
    });

    it('should filter by workspace name', async () => {
      const result = await service.list({ workspace: 'main', page: 1, pageSize: 20 });

      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
      for (const session of result.sessions) {
        expect(session.workspace).toBe('/workspaces/generacy');
      }
    });

    it('should return empty for non-existent workspace', async () => {
      const result = await service.list({ workspace: 'nonexistent', page: 1, pageSize: 20 });

      expect(result.sessions).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe('encodeWorkspacePath / decodeWorkspacePath', () => {
    it('should encode paths by replacing / with -', () => {
      expect(service.encodeWorkspacePath('/workspaces/generacy')).toBe('-workspaces-generacy');
    });

    it('should decode paths by replacing - with /', () => {
      expect(service.decodeWorkspacePath('-workspaces-generacy')).toBe('/workspaces/generacy');
    });

    it('should leave non-dash-prefixed names unchanged', () => {
      expect(service.decodeWorkspacePath('some-dir')).toBe('some-dir');
    });
  });
});
