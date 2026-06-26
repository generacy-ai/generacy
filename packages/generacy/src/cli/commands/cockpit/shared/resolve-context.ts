import { execSync } from 'node:child_process';
import { GhCliWrapper, type GhWrapper } from '@generacy-ai/cockpit';

export interface ResolveContextInput {
  issue: number;
  repo?: string;
}

export interface ResolvedContext {
  repo: string;
  issue: number;
  gh: GhWrapper;
}

function inferRepoFromGitOrigin(): string {
  const url = execSync('git remote get-url origin', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const match =
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Could not infer owner/repo from git origin URL: ${url}`,
    );
  }
  return `${match[1]}/${match[2]}`;
}

export function resolveContext(input: ResolveContextInput): ResolvedContext {
  const repo = input.repo ?? inferRepoFromGitOrigin();
  return {
    repo,
    issue: input.issue,
    gh: new GhCliWrapper(),
  };
}
