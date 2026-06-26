import {
  GhCliWrapper,
  nodeChildProcessRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';

export interface ResolveContextInput {
  issue: number;
  repo?: string;
}

export interface ResolvedContext {
  repo: string;
  issue: number;
  gh: GhWrapper;
}

async function inferRepoFromGitOrigin(): Promise<string> {
  const result = await nodeChildProcessRunner('git', [
    'remote',
    'get-url',
    'origin',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not infer owner/repo: 'git remote get-url origin' failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  const url = result.stdout.trim();
  const match =
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Could not infer owner/repo from git origin URL: ${url}`,
    );
  }
  return `${match[1]}/${match[2]}`;
}

export async function resolveContext(
  input: ResolveContextInput,
): Promise<ResolvedContext> {
  const repo = input.repo ?? (await inferRepoFromGitOrigin());
  return {
    repo,
    issue: input.issue,
    gh: new GhCliWrapper(),
  };
}
