import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionReader } from '../../../src/services/session-reader.js';

describe('SessionReader', () => {
  let tempDir: string;
  let reader: SessionReader;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `session-reader-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    reader = new SessionReader(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // File discovery
  // ---------------------------------------------------------------------------

  describe('findSessionFile', () => {
    it('should find session file without workspace (directory scan)', async () => {
      const subDir = join(tempDir, '-workspaces-myproject');
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, 'session-abc.jsonl'), '{}');

      const result = await reader.findSessionFile('session-abc');
      expect(result).toBe(join(subDir, 'session-abc.jsonl'));
    });

    it('should find session file with workspace (direct path lookup)', async () => {
      const subDir = join(tempDir, '-workspaces-myproject');
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, 'session-abc.jsonl'), '{}');

      const workspaces = { myproject: '/workspaces/myproject' };
      const result = await reader.findSessionFile('session-abc', 'myproject', workspaces);
      expect(result).toBe(join(subDir, 'session-abc.jsonl'));
    });

    it('should throw 404 when session not found (no workspace)', async () => {
      const subDir = join(tempDir, '-workspaces-myproject');
      await mkdir(subDir, { recursive: true });

      await expect(reader.findSessionFile('nonexistent')).rejects.toMatchObject({
        message: 'Session nonexistent not found',
        statusCode: 404,
      });
    });

    it('should throw 404 when session not found (with workspace)', async () => {
      const subDir = join(tempDir, '-workspaces-myproject');
      await mkdir(subDir, { recursive: true });

      const workspaces = { myproject: '/workspaces/myproject' };
      await expect(
        reader.findSessionFile('nonexistent', 'myproject', workspaces),
      ).rejects.toMatchObject({
        message: 'Session nonexistent not found',
        statusCode: 404,
      });
    });

    it('should throw 400 for unknown workspace', async () => {
      const workspaces = { myproject: '/workspaces/myproject' };
      await expect(
        reader.findSessionFile('session-abc', 'badworkspace', workspaces),
      ).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // JSONL parsing
  // ---------------------------------------------------------------------------

  describe('parseSessionFile', () => {
    it('should parse user messages', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const entry = {
        type: 'user',
        uuid: 'u1',
        parentUuid: undefined,
        timestamp: '2026-03-19T10:00:00.000Z',
        message: { role: 'user', content: 'Hello' },
      };
      await writeFile(filePath, JSON.stringify(entry));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('should parse assistant messages with content blocks', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const entry = {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-03-19T10:00:05.000Z',
        slug: 'test-slug',
        gitBranch: 'main',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me help.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test' } },
          ],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };
      await writeFile(filePath, JSON.stringify(entry));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[0].model).toBe('claude-sonnet-4-20250514');
      expect(result.messages[0].usage).toEqual({ input_tokens: 100, output_tokens: 50 });
      expect(result.messages[0].content).toHaveLength(2);
    });

    it('should promote tool_result blocks to separate messages', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const entry = {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: '2026-03-19T10:00:06.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents', is_error: false },
            { type: 'tool_result', tool_use_id: 'tool-2', content: 'other output', is_error: false },
          ],
        },
      };
      await writeFile(filePath, JSON.stringify(entry));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      // Two tool_result blocks → two separate tool_result messages
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('tool_result');
      expect(result.messages[1].role).toBe('tool_result');
      expect(result.messages[0].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'tool-1',
      });
    });

    it('should filter out queue-operation and last-prompt entries', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-03-19T10:00:00.000Z', message: { role: 'user', content: 'Hello' } }),
        JSON.stringify({ type: 'queue-operation', uuid: 'q1', timestamp: '2026-03-19T10:00:01.000Z', message: { role: 'user', content: '' } }),
        JSON.stringify({ type: 'last-prompt', uuid: 'lp1', timestamp: '2026-03-19T10:00:02.000Z', message: { role: 'user', content: '' } }),
      ];
      await writeFile(filePath, lines.join('\n'));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].uuid).toBe('u1');
    });

    it('should extract metadata from first assistant entry', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant', uuid: 'a1', timestamp: '2026-03-19T10:00:00.000Z',
          slug: 'my-slug', gitBranch: 'feature-branch',
          message: { role: 'assistant', content: 'Hi', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        JSON.stringify({
          type: 'assistant', uuid: 'a2', timestamp: '2026-03-19T10:00:05.000Z',
          slug: 'other-slug', gitBranch: 'other-branch',
          message: { role: 'assistant', content: 'More', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 200, output_tokens: 100 } },
        }),
      ];
      await writeFile(filePath, lines.join('\n'));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.metadata.slug).toBe('my-slug');
      expect(result.metadata.branch).toBe('feature-branch');
      expect(result.metadata.model).toBe('claude-sonnet-4-20250514');
      expect(result.metadata.totalInputTokens).toBe(300);
      expect(result.metadata.totalOutputTokens).toBe(150);
      expect(result.metadata.messageCount).toBe(2);
    });

    it('should skip corrupted lines and return valid messages', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-03-19T10:00:00.000Z', message: { role: 'user', content: 'Hello' } }),
        '{{corrupted json line',
        JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-03-19T10:00:01.000Z', message: { role: 'user', content: 'World' } }),
      ];
      await writeFile(filePath, lines.join('\n'));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].uuid).toBe('u1');
      expect(result.messages[1].uuid).toBe('u2');
    });

    it('should handle empty file', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      await writeFile(filePath, '');

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.messages).toHaveLength(0);
      expect(result.metadata.slug).toBeNull();
      expect(result.metadata.branch).toBeNull();
      expect(result.metadata.model).toBeNull();
    });

    it('should handle user entry with mixed text and tool_result blocks', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      const entry = {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-03-19T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Here are the results:' },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'output', is_error: false },
          ],
        },
      };
      await writeFile(filePath, JSON.stringify(entry));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      // One user message (text) + one tool_result message
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toEqual([{ type: 'text', text: 'Here are the results:' }]);
      expect(result.messages[1].role).toBe('tool_result');
    });

    it('should set isActive to false by default', async () => {
      const filePath = join(tempDir, 'test.jsonl');
      await writeFile(filePath, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-03-19T10:00:00.000Z', message: { role: 'user', content: 'Hi' } }));

      const result = await reader.parseSessionFile(filePath, 'test-session');
      expect(result.metadata.isActive).toBe(false);
    });
  });
});
