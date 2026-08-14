/**
 * Real-git regression test for issue #1088.
 *
 * A template config that declares no `branch` used to be converted to
 * `branch: 'develop'`, so `setup workspace` force-switched every checkout onto
 * `develop`. On a repo whose `develop` history is unrelated to `main` that
 * deleted `.generacy/config.yaml` from the working tree and wedged every
 * subsequent run. This exercises the update path against real git.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pino from 'pino';
import { setLogger } from '../../../utils/logger.js';
import { setupWorkspaceCommand } from '../workspace.js';

const REPO = 'finetooth-fixture';

/** Log records captured from the command under test. */
interface LogRecord {
  msg: string;
  fields: Record<string, unknown>;
}

let tempDir: string;
let workdir: string;
let checkout: string;
let logs: LogRecord[];
let savedEnv: NodeJS.ProcessEnv;
let mockExit: ReturnType<typeof vi.spyOn>;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function recordingLogger(): pino.Logger {
  const capture = (fields: unknown, msg?: unknown) => {
    if (typeof fields === 'string') logs.push({ msg: fields, fields: {} });
    else logs.push({ msg: String(msg), fields: fields as Record<string, unknown> });
  };
  return {
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  } as unknown as pino.Logger;
}

async function runSetupWorkspace(): Promise<void> {
  const command = setupWorkspaceCommand();
  await command.parseAsync(
    ['--workdir', workdir, '--config', join(checkout, '.generacy', 'config.yaml')],
    { from: 'user' },
  );
}

beforeEach(() => {
  savedEnv = { ...process.env };
  logs = [];
  setLogger(recordingLogger());
  mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  tempDir = mkdtempSync(join(tmpdir(), 'workspace-1088-'));
  workdir = join(tempDir, 'workspaces');
  checkout = join(workdir, REPO);
  mkdirSync(workdir, { recursive: true });

  // Isolate git globals so `git config --global` inside the command cannot
  // touch the developer's / CI runner's real config.
  process.env['HOME'] = tempDir;
  process.env['GIT_CONFIG_GLOBAL'] = join(tempDir, 'gitconfig');
  writeFileSync(join(tempDir, 'gitconfig'), '');
  delete process.env['GH_TOKEN'];
  delete process.env['REPO_BRANCH'];
  delete process.env['DEFAULT_BRANCH'];
  delete process.env['REPOS'];
  delete process.env['GITHUB_ORG'];
  delete process.env['CONFIG_PATH'];

  // Bare "remote" whose default branch is main.
  const remote = join(tempDir, 'remote.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);

  // Seed it with a template-format config that declares no branch.
  const seed = join(tempDir, 'seed');
  execFileSync('git', ['clone', remote, seed]);
  git(['config', 'user.email', 'test@example.com'], seed);
  git(['config', 'user.name', 'Test'], seed);
  mkdirSync(join(seed, '.generacy'), { recursive: true });
  writeFileSync(
    join(seed, '.generacy', 'config.yaml'),
    `project:\n  org_name: testorg\nrepos:\n  primary: testorg/${REPO}\n`,
  );
  git(['add', '.'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['push', 'origin', 'main'], seed);

  // The workspace checkout setup will update.
  execFileSync('git', ['clone', remote, checkout]);
  git(['config', 'user.email', 'test@example.com'], checkout);
  git(['config', 'user.name', 'Test'], checkout);
});

afterEach(() => {
  process.env = savedEnv;
  mockExit.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('setup workspace with a branchless template config (#1088)', () => {
  it('leaves the checkout on its default branch across repeated runs', async () => {
    expect(git(['branch', '--show-current'], checkout)).toBe('main');

    await runSetupWorkspace();
    await runSetupWorkspace();

    expect(git(['branch', '--show-current'], checkout)).toBe('main');
    expect(existsSync(join(checkout, '.generacy', 'config.yaml'))).toBe(true);
    expect(logs.some((l) => l.msg === 'Switching branch')).toBe(false);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('reports no branch preference in the Configuration log line', async () => {
    await runSetupWorkspace();

    const configLine = logs.find((l) => l.msg === 'Configuration');
    expect(configLine?.fields).toMatchObject({
      branch: '(repo default / current branch)',
      branchSource: 'none',
    });
  });
});
