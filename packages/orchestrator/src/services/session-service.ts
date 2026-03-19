import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import type { SessionMetadata, SessionListResponse, ListSessionsQuery } from '../types/index.js';

/**
 * Internal accumulator used during JSONL streaming
 */
interface SessionAccumulator {
  sessionId: string;
  slug: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  model: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  workspace: string | null;
}

export interface SessionServiceOptions {
  /** Override the Claude projects directory (default: ~/.claude/projects) */
  claudeProjectsDir?: string;
  /** Workspace name → filesystem path mapping from config */
  workspaces?: Record<string, string>;
}

export class SessionService {
  private readonly claudeProjectsDir: string;
  private readonly workspaces: Record<string, string>;

  constructor(options: SessionServiceOptions = {}) {
    this.claudeProjectsDir =
      options.claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects');
    this.workspaces = options.workspaces ?? {};
  }

  /**
   * Discover session directories under ~/.claude/projects/
   */
  async discoverDirectories(baseDir?: string): Promise<string[]> {
    const dir = baseDir ?? this.claudeProjectsDir;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * Parse a single JSONL session file to extract metadata
   */
  async parseSessionFile(filePath: string, workspace: string | null): Promise<SessionMetadata | null> {
    const filename = path.basename(filePath, '.jsonl');
    // Validate UUID format loosely
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
      return null;
    }

    const acc: SessionAccumulator = {
      sessionId: filename,
      slug: null,
      startedAt: null,
      lastActivityAt: null,
      messageCount: 0,
      model: null,
      gitBranch: null,
      permissionMode: null,
      workspace,
    };

    try {
      const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          this.processLine(parsed, acc);
        } catch {
          // Skip malformed JSON lines
        }
      }
    } catch {
      // Skip files that can't be read
      return null;
    }

    // Must have at least a timestamp to be valid
    if (!acc.startedAt || !acc.lastActivityAt) {
      return null;
    }

    return {
      sessionId: acc.sessionId,
      slug: acc.slug,
      startedAt: acc.startedAt,
      lastActivityAt: acc.lastActivityAt,
      messageCount: acc.messageCount,
      model: acc.model,
      gitBranch: acc.gitBranch,
      type: acc.permissionMode === 'bypassPermissions' ? 'automated' : 'developer',
      workspace: acc.workspace,
    };
  }

  /**
   * List sessions with optional filtering, sorting, and pagination
   */
  async list(query: ListSessionsQuery): Promise<SessionListResponse> {
    const dirs = await this.getDirectories(query.workspace);
    const sessions: SessionMetadata[] = [];

    for (const dir of dirs) {
      const workspace = this.decodeWorkspacePath(path.basename(dir));
      const files = await this.getSessionFiles(dir);

      for (const file of files) {
        const metadata = await this.parseSessionFile(file, workspace);
        if (metadata) {
          sessions.push(metadata);
        }
      }
    }

    // Sort by lastActivityAt descending
    sessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );

    // Paginate
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const total = sessions.length;
    const start = (page - 1) * pageSize;
    const paginated = sessions.slice(start, start + pageSize);

    return {
      sessions: paginated,
      pagination: {
        page,
        pageSize,
        total,
        hasMore: start + pageSize < total,
      },
    };
  }

  /**
   * Get directories to scan, optionally filtered by workspace
   */
  private async getDirectories(workspaceFilter?: string): Promise<string[]> {
    if (workspaceFilter) {
      // Check if workspace name maps to a configured path
      const workspacePath = this.workspaces[workspaceFilter];
      if (workspacePath) {
        const encoded = this.encodeWorkspacePath(workspacePath);
        const dir = path.join(this.claudeProjectsDir, encoded);
        try {
          await fs.access(dir);
          return [dir];
        } catch {
          return [];
        }
      }

      // Try matching directory names directly
      const allDirs = await this.discoverDirectories();
      return allDirs.filter((dir) => {
        const decoded = this.decodeWorkspacePath(path.basename(dir));
        return decoded === workspaceFilter || path.basename(dir) === workspaceFilter;
      });
    }

    return this.discoverDirectories();
  }

  /**
   * Get .jsonl files in a directory
   */
  private async getSessionFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * Encode a workspace path to directory name (/ → -)
   */
  encodeWorkspacePath(workspacePath: string): string {
    return workspacePath.replace(/\//g, '-');
  }

  /**
   * Decode a directory name to workspace path (leading -, then - → /)
   */
  decodeWorkspacePath(dirName: string): string {
    // Claude Code convention: /workspaces/foo → -workspaces-foo
    if (dirName.startsWith('-')) {
      return dirName.replace(/-/g, '/');
    }
    return dirName;
  }

  /**
   * Process a single parsed JSONL line into the accumulator
   */
  private processLine(parsed: Record<string, unknown>, acc: SessionAccumulator): void {
    const type = parsed.type as string | undefined;
    const timestamp = parsed.timestamp as string | undefined;

    if (timestamp) {
      if (!acc.startedAt) {
        acc.startedAt = timestamp;
      }
      acc.lastActivityAt = timestamp;
    }

    if (type === 'user' || type === 'assistant') {
      acc.messageCount++;
    }

    if (type === 'user') {
      if (parsed.slug != null) {
        acc.slug = parsed.slug as string;
      }
      if (parsed.gitBranch != null && !acc.gitBranch) {
        acc.gitBranch = parsed.gitBranch as string;
      }
      if (parsed.permissionMode != null && !acc.permissionMode) {
        acc.permissionMode = parsed.permissionMode as string;
      }
    }

    if (type === 'assistant' && !acc.model) {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (message?.model) {
        acc.model = message.model as string;
      }
    }
  }
}
