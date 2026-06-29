import { Command } from 'commander';
import {
  GhCliWrapper,
  loadCockpitConfig,
} from '@generacy-ai/cockpit';
import { resolveScope } from './shared/scoping.js';
import { runOnePoll } from './watch/poll-loop.js';
import { emit } from './watch/emit.js';
import type { SnapshotMap } from './watch/snapshot.js';

interface WatchOptions {
  epic?: string;
  repos?: string;
  interval?: string;
  safetyCap?: string;
}

function parseRepos(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntFlag(name: string, raw: string | undefined, min: number, defaultValue: number): number {
  if (raw == null) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${min}`);
  }
  return n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function watchCommand(): Command {
  return new Command('watch')
    .description('Emit one NDJSON line per issue/PR state transition. Pure sensor.')
    .option('--epic <ownerRepoIssue>', 'Scope to a single epic. Format owner/repo#NNN.')
    .option('--repos <list>', 'Comma-separated owner/name list to override cockpit.repos.')
    .option('--interval <ms>', 'Poll interval in ms (default 5000, minimum 1000).')
    .option('--safety-cap <n>', 'Warn when per-poll item count exceeds this (default 1000).')
    .action(async (options: WatchOptions) => {
      try {
        const interval = parseIntFlag('interval', options.interval, 1000, 5000);
        const safetyCap = parseIntFlag('safety-cap', options.safetyCap, 1, 1000);
        const reposOverride = parseRepos(options.repos);

        const loaded = await loadCockpitConfig();
        const gh = new GhCliWrapper();

        let scope;
        try {
          scope = await resolveScope({
            ...(options.epic != null ? { epic: options.epic } : {}),
            ...(reposOverride != null ? { reposOverride } : {}),
            config: loaded.config,
            gh,
            logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
          });
        } catch (err) {
          process.stderr.write(`cockpit: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }

        const reposLabel =
          scope.kind === 'epic' ? scope.ownerRepo : scope.repos.join(', ');
        process.stderr.write(
          `cockpit: watching ${reposLabel}; emitting on transition (interval=${interval}ms)\n`,
        );

        const controller = new AbortController();
        let stopped = false;
        const onStop = (): void => {
          stopped = true;
          controller.abort();
        };
        process.once('SIGINT', onStop);
        process.once('SIGTERM', onStop);

        let prev: SnapshotMap = new Map();
        while (!stopped) {
          try {
            const result = await runOnePoll(prev, {
              gh,
              scope,
              safetyCap,
              logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
            });
            for (const event of result.events) {
              emit(event);
            }
            prev = result.curr;
          } catch (err) {
            process.stderr.write(
              `cockpit: poll error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(3);
          }
          if (stopped) break;
          await sleep(interval, controller.signal);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `cockpit: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
}
