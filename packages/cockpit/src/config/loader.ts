import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { findWorkspaceConfigPath } from '@generacy-ai/config';
import { parse as parseYaml } from 'yaml';
import {
  CockpitConfigSchema,
  type CockpitConfig,
  type CockpitConfigSource,
  type LoadedCockpitConfig,
} from './schema.js';

const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;
const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const MISSING_REPOS_WARN =
  'cockpit: no repos configured (set cockpit.repos in .generacy/config.yaml or MONITORED_REPOS env)';

export interface LoadCockpitConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  whoami?: () => Promise<string | null>;
  logger?: { warn: (msg: string) => void };
}

function parseMonitoredReposEnv(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    if (!OWNER_REPO_REGEX.test(entry)) {
      throw new Error(
        `MONITORED_REPOS contains invalid entry "${entry}" — must be owner/repo`,
      );
    }
  }
  return entries;
}

async function parseGhWhoami(): Promise<string | null> {
  // Lazy import — only runs when no explicit owner is configured.
  const { execFile } = await import('node:child_process');
  return new Promise<string | null>((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 5_000 }, (error, stdout, stderr) => {
      const combined = `${stdout}\n${stderr}`;
      if (error != null && combined.length === 0) {
        resolve(null);
        return;
      }
      // gh auth status prints "Logged in to github.com as <login>" (newer versions)
      // or "Logged in to github.com account <login>" depending on version.
      const match =
        combined.match(/Logged in to [^\s]+ as ([A-Za-z0-9-]+)/) ??
        combined.match(/account ([A-Za-z0-9-]+)/);
      if (match?.[1] != null) {
        resolve(match[1]);
        return;
      }
      resolve(null);
    });
  });
}

export async function loadCockpitConfig(
  options: LoadCockpitConfigOptions = {},
): Promise<LoadedCockpitConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const whoami = options.whoami ?? parseGhWhoami;
  const logger = options.logger ?? console;
  const warnings: string[] = [];

  // 1. Locate workspace config file.
  const configPath = findWorkspaceConfigPath(cwd);
  let cockpitBlock: unknown = undefined;
  if (configPath != null && existsSync(configPath)) {
    let raw: string;
    try {
      raw = await readFile(configPath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to read ${configPath}: ${msg}`);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to parse YAML at ${configPath}: ${msg}`);
    }
    if (parsed != null && typeof parsed === 'object') {
      const doc = parsed as Record<string, unknown>;
      cockpitBlock = doc['cockpit'];
    }
  }

  // 2. Validate the cockpit block (throws on malformed).
  const parsedCockpit = CockpitConfigSchema.parse(cockpitBlock ?? {});

  // 3. Resolve repos.
  let repos = parsedCockpit.repos;
  let source: CockpitConfigSource;
  if (repos.length > 0) {
    source = 'cockpit-block';
  } else {
    const monitoredReposEnv = env['MONITORED_REPOS'];
    if (monitoredReposEnv != null && monitoredReposEnv.trim().length > 0) {
      repos = parseMonitoredReposEnv(monitoredReposEnv);
      source = 'monitored-repos-env';
    } else {
      source = 'defaults';
      warnings.push(MISSING_REPOS_WARN);
      logger.warn(MISSING_REPOS_WARN);
    }
  }

  // 4. Resolve owner.
  let owner: string | undefined = parsedCockpit.owner;
  if (owner == null) {
    try {
      const login = await whoami();
      if (login != null && login.length > 0) {
        owner = login;
      }
    } catch {
      // gh failure is non-fatal — leave owner undefined.
    }
  }

  // 5. Resolve orchestrator.
  const orchestratorBlock = parsedCockpit.orchestrator ?? {};
  const token =
    orchestratorBlock.token ??
    (env['ORCHESTRATOR_API_TOKEN'] != null && env['ORCHESTRATOR_API_TOKEN'].length > 0
      ? env['ORCHESTRATOR_API_TOKEN']
      : undefined);
  const baseUrl =
    orchestratorBlock.baseUrl ??
    (env['ORCHESTRATOR_URL'] != null && env['ORCHESTRATOR_URL'].length > 0
      ? env['ORCHESTRATOR_URL']
      : DEFAULT_BASE_URL);

  const config: CockpitConfig = {
    owner,
    repos,
    orchestrator: {
      baseUrl,
      ...(token != null ? { token } : {}),
    },
    stuckThresholdMinutes: parsedCockpit.stuckThresholdMinutes,
  };

  return { config, source, warnings };
}
