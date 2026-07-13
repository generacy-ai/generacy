/**
 * `generacy cockpit scope add|remove <scope-ref> <issue-ref>` — mutate the
 * task-list membership of a scope (epic or tracking) issue's body.
 *
 * Both sub-verbs route through `writeScopeWithRetry` which reads the current
 * body, applies a pure mutation, writes back, and verifies. Idempotent
 * (already-present `add`, already-absent `remove` = noop). Terminal contention
 * throws `ScopeContendedError` (exit 1, code `SCOPE_ADD_CONTENDED`).
 */
import { Command } from 'commander';
import {
  loadCockpitConfig,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveIssueContext, type IssueRef as CliIssueRef } from './resolver.js';
import { CockpitExit, isCockpitExit } from './exit.js';
import { writeScopeWithRetry } from './scope/retry.js';
import { ScopeContendedError } from './scope/errors.js';

export interface ScopeCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: typeof loadCockpitConfig;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function toCockpitIssueRef(ref: CliIssueRef): { repo: string; number: number } {
  return { repo: ref.nwo, number: ref.number };
}

export function scopeCommand(deps: ScopeCommandDeps = {}): Command {
  const cmd = new Command('scope');
  cmd.description('Add or remove a task-list ref from a scope (epic or tracking) issue.');

  cmd
    .command('add')
    .description('Append <issue-ref> to <scope-ref>\'s body (concurrency-safe).')
    .argument('<scope-ref>', 'Scope issue ref — <n>, <owner>/<repo>#<n>, or full URL.')
    .argument('<issue-ref>', 'Issue ref to append.')
    .action(async (scopeArg: string, issueArg: string) => {
      try {
        await runScope('add', scopeArg, issueArg, deps);
      } catch (err) {
        if (isCockpitExit(err)) {
          const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
          stderr(err.message);
          process.exit(err.code);
        }
        throw err;
      }
    });

  cmd
    .command('remove')
    .description('Remove <issue-ref> from <scope-ref>\'s body (concurrency-safe).')
    .argument('<scope-ref>', 'Scope issue ref — <n>, <owner>/<repo>#<n>, or full URL.')
    .argument('<issue-ref>', 'Issue ref to remove.')
    .action(async (scopeArg: string, issueArg: string) => {
      try {
        await runScope('remove', scopeArg, issueArg, deps);
      } catch (err) {
        if (isCockpitExit(err)) {
          const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
          stderr(err.message);
          process.exit(err.code);
        }
        throw err;
      }
    });

  return cmd;
}

export async function runScope(
  kind: 'add' | 'remove',
  scopeArg: string,
  issueArg: string,
  deps: ScopeCommandDeps,
): Promise<void> {
  const log = getLogger();
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let scopeRef: CliIssueRef;
  let issueRef: CliIssueRef;
  let gh: GhWrapper;
  try {
    const scopeCtx = await resolveIssueContext({ issue: scopeArg, runner: deps.runner });
    scopeRef = scopeCtx.ref;
    gh = deps.gh ?? scopeCtx.gh;
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit scope ${kind}: ${(err as Error).message}`);
  }

  try {
    const issueCtx = await resolveIssueContext({ issue: issueArg, runner: deps.runner });
    issueRef = issueCtx.ref;
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit scope ${kind}: ${(err as Error).message}`);
  }

  const ref = toCockpitIssueRef(issueRef);
  const scope = toCockpitIssueRef(scopeRef);

  try {
    const result = await writeScopeWithRetry({
      gh,
      scope,
      mutation: { kind, ref },
    });
    if (kind === 'add') {
      print(
        `scope add: ${issueRef.nwo}#${issueRef.number} → ${scopeRef.nwo}#${scopeRef.number} ` +
          `(shape=${result.shape}, attempts=${result.attempts}, alreadyPresent=${result.noop})`,
      );
    } else {
      print(
        `scope remove: ${issueRef.nwo}#${issueRef.number} ✕ ${scopeRef.nwo}#${scopeRef.number} ` +
          `(attempts=${result.attempts}, alreadyAbsent=${result.noop})`,
      );
    }
  } catch (err) {
    if (err instanceof ScopeContendedError) {
      throw new CockpitExit(
        1,
        `Error: cockpit scope ${kind}: ${err.code} after ${err.attempts} attempts; ` +
          `retry once, or edit the scope issue body directly`,
      );
    }
    throw new CockpitExit(
      1,
      `Error: cockpit scope ${kind}: ${(err as Error).message}`,
    );
  }
}
