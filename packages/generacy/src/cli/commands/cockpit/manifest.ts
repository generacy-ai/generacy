/**
 * `generacy cockpit manifest <init|sync>` — create and reconcile the per-epic
 * manifest at `.generacy/epics/<slug>.yaml`.
 *
 * Both subverbs share the same testing seams (`runner` / `gh` / `stdout` /
 * `stderr` / `cwd`) and emit `CockpitExit` for all error paths. The action
 * wrappers translate `CockpitExit` to `process.exit(code)` after writing to
 * stderr.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  GhCliWrapper,
  nodeChildProcessRunner,
  readManifest,
  writeManifest,
  type CommandRunner,
  type EpicManifest,
  type GhWrapper,
  type Issue,
  type PhaseEntry,
} from '@generacy-ai/cockpit';
import { CockpitExit, isCockpitExit } from './exit.js';
import { parseEpicBody, type ParsedEpicBody, type ParsedPhase } from './manifest/parse-epic-body.js';
import { deriveSlug, resolveTargetPath } from './manifest/derive-slug.js';
import { resolveManifestPath } from './manifest/resolve-manifest-path.js';
import { applyChangeSet, diffPhases, isEmpty, type ChangeSet } from './manifest/diff-phases.js';

export interface ManifestCommandDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
}

interface InitOptions {
  slug?: string;
  force?: boolean;
  json?: boolean;
  manifestRoot?: string;
}

interface SyncOptions {
  epic?: string;
  json?: boolean;
  manifestRoot?: string;
}

interface EpicRef {
  owner: string;
  repo: string;
  number: number;
  nwo: string;
}

const EPIC_REF_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

function parseEpicRef(raw: string, verb: 'init' | 'sync'): EpicRef {
  const m = raw.match(EPIC_REF_RE);
  if (m == null) {
    throw new CockpitExit(
      2,
      `Error: cockpit manifest ${verb}: invalid epic ref "${raw}" — expected owner/repo#n.`,
    );
  }
  const owner = m[1]!;
  const repo = m[2]!;
  const number = Number.parseInt(m[3]!, 10);
  return { owner, repo, number, nwo: `${owner}/${repo}` };
}

async function fetchEpicIssue(
  gh: GhWrapper,
  ref: EpicRef,
  verb: 'init' | 'sync',
): Promise<Issue> {
  let issues: Issue[];
  try {
    issues = await gh.listIssues(`repo:${ref.nwo} is:issue ${ref.number}`);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest ${verb}: gh search issues: ${(err as Error).message}`,
    );
  }
  const issue = issues.find((i) => i.number === ref.number) ?? issues[0];
  if (issue == null) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest ${verb}: gh issue not found: ${ref.nwo}#${ref.number}`,
    );
  }
  return issue;
}

function defaultManifestRoot(cwd: string): string {
  return join(cwd, '.generacy', 'epics');
}

function formatPhaseLabel(index: number, name: string): string {
  const stripped = name.replace(/^P\d+\s*(?:—|-)?\s*/i, '').trim();
  return stripped.length > 0 ? `P${index}: ${stripped}` : `P${index}`;
}

function formatRemovedLabel(phase: PhaseEntry): string {
  const idxMatch = phase.name.match(/\bP(\d+)\b/i);
  if (idxMatch != null) {
    const idx = Number.parseInt(idxMatch[1]!, 10);
    return formatPhaseLabel(idx, phase.name);
  }
  return phase.name;
}

function buildJsonChanges(
  changes: ChangeSet,
): {
  phasesAdded: string[];
  phasesRemoved: string[];
  phasesRenamed: Array<{ from: string; to: string }>;
  issuesAdded: Record<string, string[]>;
  issuesRemoved: Record<string, string[]>;
  planChanged?: { from: string; to: string };
} {
  const out: {
    phasesAdded: string[];
    phasesRemoved: string[];
    phasesRenamed: Array<{ from: string; to: string }>;
    issuesAdded: Record<string, string[]>;
    issuesRemoved: Record<string, string[]>;
    planChanged?: { from: string; to: string };
  } = {
    phasesAdded: changes.phasesAdded.map((p) => formatPhaseLabel(p.index, p.name)),
    phasesRemoved: changes.phasesRemoved.map(formatRemovedLabel),
    phasesRenamed: changes.phasesRenamed.map((r) => ({ from: r.from, to: r.to })),
    issuesAdded: changes.issuesAdded,
    issuesRemoved: changes.issuesRemoved,
  };
  if (changes.planChanged != null) out.planChanged = changes.planChanged;
  return out;
}

function buildManifestFromParsed(ref: EpicRef, slug: string, parsed: ParsedEpicBody): EpicManifest {
  const phases: PhaseEntry[] = parsed.phases.map<PhaseEntry>((p: ParsedPhase) => ({
    name: p.name,
    ...(p.tier != null ? { tier: p.tier } : {}),
    repos: [],
    issues: [...p.issues],
  }));
  return {
    epic: {
      repo: ref.nwo,
      issue: ref.number,
      slug,
      plan: parsed.plan,
    },
    autonomy: {},
    phases,
  };
}

function countIssues(phases: ParsedPhase[] | PhaseEntry[]): number {
  let n = 0;
  for (const p of phases) n += p.issues.length;
  return n;
}

export async function runInit(
  epicRefRaw: string,
  opts: InitOptions,
  deps: ManifestCommandDeps,
): Promise<void> {
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const cwd = deps.cwd ?? process.cwd();

  const ref = parseEpicRef(epicRefRaw, 'init');
  const gh = deps.gh ?? new GhCliWrapper(deps.runner ?? nodeChildProcessRunner);
  const issue = await fetchEpicIssue(gh, ref, 'init');

  const parsed = parseEpicBody(issue.body);
  const derivedSlug = deriveSlug(issue.title, ref.number);
  const manifestRoot = opts.manifestRoot ?? defaultManifestRoot(cwd);
  const target = resolveTargetPath({
    manifestRoot,
    slug: opts.slug,
    derivedFromTitle: derivedSlug,
  });

  if (existsSync(target.path) && opts.force !== true) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest init: ${target.path} already exists. Pass --force to overwrite or --slug <other> to choose a different name.`,
    );
  }

  const manifest = buildManifestFromParsed(ref, target.slug, parsed);

  try {
    await writeManifest(target.path, manifest);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest init: write failed at ${target.path}: ${(err as Error).message}`,
    );
  }

  if (opts.json === true) {
    const payload = {
      verb: 'init' as const,
      path: target.path,
      epic: `${ref.nwo}#${ref.number}`,
      wrote: true,
      changes: {
        phasesAdded: parsed.phases.map((p) => formatPhaseLabel(p.index, p.name)),
        phasesRemoved: [] as string[],
        phasesRenamed: [] as Array<{ from: string; to: string }>,
        issuesAdded: parsed.phases.reduce<Record<string, string[]>>((acc, p) => {
          if (p.issues.length > 0) acc[`P${p.index}`] = [...p.issues];
          return acc;
        }, {}),
        issuesRemoved: {} as Record<string, string[]>,
      },
    };
    print(JSON.stringify(payload));
    return;
  }

  const phaseCount = parsed.phases.length;
  const issueCount = countIssues(parsed.phases);
  print(
    `wrote ${target.path} (${phaseCount} phase${phaseCount === 1 ? '' : 's'}, ${issueCount} issue${issueCount === 1 ? '' : 's'})`,
  );
}

export async function runSync(
  opts: SyncOptions,
  deps: ManifestCommandDeps,
): Promise<void> {
  const print = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const cwd = deps.cwd ?? process.cwd();
  const manifestRoot = opts.manifestRoot ?? defaultManifestRoot(cwd);

  const resolution = await resolveManifestPath({ manifestRoot, epic: opts.epic });
  if (resolution.kind === 'not-found') {
    if (opts.epic != null && opts.epic.length > 0) {
      throw new CockpitExit(
        2,
        `Error: cockpit manifest sync: no manifest found at ${join(manifestRoot, `${opts.epic}.yaml`)}. Run 'cockpit manifest init <epic-ref>' first.`,
      );
    }
    throw new CockpitExit(
      2,
      `Error: cockpit manifest sync: no manifest found under ${manifestRoot}. Run 'cockpit manifest init <epic-ref>' first.`,
    );
  }
  if (resolution.kind === 'ambiguous') {
    throw new CockpitExit(
      2,
      `Error: cockpit manifest sync: multiple manifests found (${resolution.matches.join(', ')}). Pass --epic <slug>.`,
    );
  }

  const manifestPath = resolution.path;
  let existing: EpicManifest | null;
  try {
    existing = await readManifest(manifestPath);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest sync: failed to read ${manifestPath}: ${(err as Error).message}`,
    );
  }
  if (existing == null) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest sync: manifest at ${manifestPath} disappeared mid-run.`,
    );
  }

  const epicRefStr = `${existing.epic.repo}#${existing.epic.issue}`;
  const ref = parseEpicRef(epicRefStr, 'sync');
  const gh = deps.gh ?? new GhCliWrapper(deps.runner ?? nodeChildProcessRunner);
  const issue = await fetchEpicIssue(gh, ref, 'sync');

  const parsed = parseEpicBody(issue.body);
  const changes = diffPhases(parsed, existing);

  if (isEmpty(changes)) {
    if (opts.json === true) {
      const payload = {
        verb: 'sync' as const,
        path: manifestPath,
        epic: epicRefStr,
        wrote: false,
        changes: {
          phasesAdded: [] as string[],
          phasesRemoved: [] as string[],
          phasesRenamed: [] as Array<{ from: string; to: string }>,
          issuesAdded: {} as Record<string, string[]>,
          issuesRemoved: {} as Record<string, string[]>,
        },
      };
      print(JSON.stringify(payload));
    } else {
      print('no changes');
    }
    return;
  }

  applyChangeSet(existing, changes, parsed);
  try {
    await writeManifest(manifestPath, existing);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit manifest sync: write failed at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  if (opts.json === true) {
    const payload = {
      verb: 'sync' as const,
      path: manifestPath,
      epic: epicRefStr,
      wrote: true,
      changes: buildJsonChanges(changes),
    };
    print(JSON.stringify(payload));
    return;
  }

  const addedPhases = changes.phasesAdded.length;
  const removedPhases = changes.phasesRemoved.length;
  const addedIssues = Object.values(changes.issuesAdded).reduce((a, v) => a + v.length, 0);
  const removedIssues = Object.values(changes.issuesRemoved).reduce((a, v) => a + v.length, 0);
  print(
    `synced ${manifestPath}: +${addedPhases} phase${addedPhases === 1 ? '' : 's'}, -${removedPhases} phase${removedPhases === 1 ? '' : 's'}, +${addedIssues} issue${addedIssues === 1 ? '' : 's'}, -${removedIssues} issue${removedIssues === 1 ? '' : 's'}`,
  );
  for (const rename of changes.phasesRenamed) {
    print(`  P${rename.index} renamed: "${rename.from}" → "${rename.to}"`);
  }
  for (const [key, refs] of Object.entries(changes.issuesAdded)) {
    print(`  ${key}: +${refs.length} (added ${refs.join(', ')})`);
  }
  for (const [key, refs] of Object.entries(changes.issuesRemoved)) {
    print(`  ${key}: -${refs.length} (removed ${refs.join(', ')})`);
  }
  for (const added of changes.phasesAdded) {
    print(`  ${formatPhaseLabel(added.index, added.name)} (new): ${added.issues.length} issue${added.issues.length === 1 ? '' : 's'}`);
  }
  if (changes.planChanged != null) {
    print(`  plan: ${changes.planChanged.from} → ${changes.planChanged.to}`);
  }
}

function wrapAction<TArgs extends unknown[]>(
  deps: ManifestCommandDeps,
  fn: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (err) {
      if (isCockpitExit(err)) {
        const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
        stderr(err.message);
        process.exit(err.code);
      }
      throw err;
    }
  };
}

export function manifestCommand(deps: ManifestCommandDeps = {}): Command {
  const cmd = new Command('manifest');
  cmd.description('Create and reconcile the per-epic manifest YAML.');

  const init = new Command('init');
  init
    .description('Create a new manifest from an epic issue body.')
    .argument('<epic-ref>', 'Epic ref in `owner/repo#n` form.')
    .option('--slug <slug>', 'Override the slug derived from the epic title.')
    .option('--force', 'Overwrite the target file if it already exists.')
    .option('--json', 'Emit a single-line JSON object on stdout.')
    .option('--manifest-root <dir>', 'Override the default `.generacy/epics/` directory.')
    .action(
      wrapAction(deps, async (epicRef: string, opts: InitOptions) => {
        await runInit(epicRef, opts, deps);
      }),
    );

  const sync = new Command('sync');
  sync
    .description('Reconcile an existing manifest with the current epic body.')
    .option('--epic <slug>', 'Pick a specific manifest by slug (bypasses single-manifest auto-resolution).')
    .option('--json', 'Emit a single-line JSON object on stdout.')
    .option('--manifest-root <dir>', 'Override the default `.generacy/epics/` directory.')
    .action(
      wrapAction(deps, async (opts: SyncOptions) => {
        await runSync(opts, deps);
      }),
    );

  cmd.addCommand(init);
  cmd.addCommand(sync);
  return cmd;
}
