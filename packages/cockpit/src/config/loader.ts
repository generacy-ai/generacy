import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { findWorkspaceConfigPath } from '@generacy-ai/config';
import { parse as parseYaml } from 'yaml';
import {
  CockpitAutoConfigSchema,
  CockpitBaseConfigSchema,
  type CockpitAutoConfig,
  type CockpitConfig,
  type CockpitConfigSource,
  type LoadedCockpitConfig,
} from './schema.js';

export interface LoadCockpitConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  whoami?: () => Promise<string | null>;
  logger?: { warn: (msg: string) => void };
}

async function parseGhWhoami(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise<string | null>((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 5_000 }, (error, stdout, stderr) => {
      const combined = `${stdout}\n${stderr}`;
      if (error != null && combined.length === 0) {
        resolve(null);
        return;
      }
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
  const whoami = options.whoami ?? parseGhWhoami;
  const warnings: string[] = [];

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

  const parsedCockpit = CockpitBaseConfigSchema.parse(cockpitBlock ?? {});

  // `auto` degrades to a warning on parse failure so a bad (or newer) auto
  // block never breaks owner/assignee consumers (advance, queue, resume, …).
  let auto: CockpitAutoConfig | undefined;
  if (cockpitBlock != null && typeof cockpitBlock === 'object') {
    const autoRaw = (cockpitBlock as Record<string, unknown>)['auto'];
    if (autoRaw !== undefined) {
      const autoResult = CockpitAutoConfigSchema.safeParse(autoRaw);
      if (autoResult.success) {
        auto = autoResult.data;
      } else {
        const detail = autoResult.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        warnings.push(`cockpit.auto ignored (invalid): ${detail}`);
      }
    }
  }

  const source: CockpitConfigSource =
    parsedCockpit.owner != null || parsedCockpit.assignee != null || auto != null
      ? 'cockpit-block'
      : 'defaults';

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

  const config: CockpitConfig = { owner, assignee: parsedCockpit.assignee, auto };

  return { config, source, warnings };
}
