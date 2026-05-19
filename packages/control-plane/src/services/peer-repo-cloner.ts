import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRelayPushEvent } from '../relay-events.js';

export interface CloneResult {
  repo: string;
  status: 'done' | 'failed' | 'skipped';
  message?: string;
}

export interface PeerRepoClonerOptions {
  repos: string[];
  token?: string;
  workspacesDir?: string;
}

function extractRepoName(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, '').split('/').pop()!;
}

function buildCloneUrl(repo: string, token?: string): string {
  if (!token) return repo;
  const url = new URL(repo);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function emitBootstrapEvent(data: unknown): void {
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.bootstrap', data);
  }
}

function spawnClone(cloneUrl: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', cloneUrl, targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git clone exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

export async function clonePeerRepos(options: PeerRepoClonerOptions): Promise<CloneResult[]> {
  const workspacesDir = options.workspacesDir ?? '/workspaces';
  const { repos, token } = options;

  if (repos.length === 0) {
    emitBootstrapEvent({ status: 'done', message: 'no peer repos' });
    return [];
  }

  const results: CloneResult[] = [];

  for (const repo of repos) {
    const name = extractRepoName(repo);
    const targetDir = path.join(workspacesDir, name);

    // Idempotency: skip if directory already exists
    try {
      const stat = await fs.stat(targetDir);
      if (stat.isDirectory()) {
        emitBootstrapEvent({ repo, status: 'done' });
        results.push({ repo, status: 'skipped' });
        continue;
      }
    } catch {
      // Directory doesn't exist — proceed with clone
    }

    emitBootstrapEvent({ repo, status: 'cloning' });

    try {
      const cloneUrl = buildCloneUrl(repo, token);
      await spawnClone(cloneUrl, targetDir);
      emitBootstrapEvent({ repo, status: 'done' });
      results.push({ repo, status: 'done' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      emitBootstrapEvent({ repo, status: 'failed', message });
      results.push({ repo, status: 'failed', message });
    }
  }

  return results;
}
