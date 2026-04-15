import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadConfig } from '@generacy-ai/credhelper';
import { CredhelperError } from '../../src/errors.js';
import { Daemon } from '../../src/daemon.js';
import { CORE_PLUGINS } from '../../src/plugins/core/index.js';
import { DefaultBackendClientFactory } from '../../src/backends/factory.js';
import type { CredentialTypePlugin, DaemonConfig } from '../../src/types.js';

/** Make an HTTP request over a Unix socket. */
function request(
  socketPath: string,
  method: string,
  urlPath: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { socketPath, method, path: urlPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const VALID_BACKENDS_YAML = `schemaVersion: "1"
backends:
  - id: env-backend
    type: env
`;

const VALID_CREDENTIALS_YAML = `schemaVersion: "1"
credentials:
  - id: test-secret
    type: env-passthrough
    backend: env-backend
    backendKey: TEST_SECRET_VAR
`;

const VALID_ROLE_YAML = `schemaVersion: "1"
id: test-role
description: Test role for config loading integration test
credentials:
  - ref: test-secret
    expose:
      - as: env
        name: TEST_SECRET
`;

const INVALID_ROLE_YAML = `schemaVersion: "1"
id: bad-role
description: Role referencing nonexistent credential
credentials:
  - ref: nonexistent-credential
    expose:
      - as: env
        name: X
`;

/** Create a minimal valid .agency/ directory structure. */
async function createValidAgencyDir(agencyDir: string): Promise<void> {
  const secretsDir = path.join(agencyDir, 'secrets');
  const rolesDir = path.join(agencyDir, 'roles');
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.mkdir(rolesDir, { recursive: true });

  await fs.writeFile(path.join(secretsDir, 'backends.yaml'), VALID_BACKENDS_YAML);
  await fs.writeFile(path.join(secretsDir, 'credentials.yaml'), VALID_CREDENTIALS_YAML);
  await fs.writeFile(path.join(rolesDir, 'test-role.yaml'), VALID_ROLE_YAML);
}

/** Build a DaemonConfig from a real loadConfig() result. */
function buildDaemonConfig(
  agencyDir: string,
  controlSocketPath: string,
  sessionsDir: string,
): DaemonConfig {
  const appConfig = loadConfig({ agencyDir });

  const pluginMap = new Map<string, CredentialTypePlugin>();
  for (const plugin of CORE_PLUGINS) {
    pluginMap.set(plugin.type, plugin);
  }

  return {
    controlSocketPath,
    sessionsDir,
    workerUid: 1000,
    workerGid: 1000,
    daemonUid: 1002,
    backendFactory: new DefaultBackendClientFactory(),
    configLoader: {
      async loadRole(roleId: string) {
        const role = appConfig.roles.get(roleId);
        if (!role) throw new CredhelperError('ROLE_NOT_FOUND', `Role not found: ${roleId}`);
        return role;
      },
      async loadCredential(credentialId: string) {
        const cred = appConfig.credentials.credentials.find(c => c.id === credentialId);
        if (!cred) throw new CredhelperError('CREDENTIAL_NOT_FOUND', `Credential not found: ${credentialId}`);
        return cred;
      },
      async loadBackend(backendId: string) {
        const backend = appConfig.backends.backends.find(b => b.id === backendId);
        if (!backend) throw new CredhelperError('BACKEND_UNREACHABLE', `Backend not found: ${backendId}`);
        return backend;
      },
    },
    pluginRegistry: {
      getPlugin(credentialType: string) {
        const plugin = pluginMap.get(credentialType);
        if (!plugin) throw new Error(`No plugin for type: ${credentialType}`);
        return plugin;
      },
    },
    sweepIntervalMs: 30000,
    enablePeerCred: false,
  };
}

describe('Integration: Config Loading (Happy Path)', () => {
  let tmpDir: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-cfg-'));
    process.env.TEST_SECRET_VAR = 'test-secret-value';
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    delete process.env.TEST_SECRET_VAR;
  });

  it('daemon starts with valid .agency/ config and resolves roles via POST /sessions', async () => {
    const agencyDir = path.join(tmpDir, '.agency');
    await createValidAgencyDir(agencyDir);

    const controlSocketPath = path.join(tmpDir, 'control.sock');
    const sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const config = buildDaemonConfig(agencyDir, controlSocketPath, sessionsDir);
    daemon = new Daemon(config);
    await daemon.start();

    // Verify daemon is ready by making a POST /sessions request
    const beginRes = await request(controlSocketPath, 'POST', '/sessions', {
      role: 'test-role',
      session_id: 'config-test-session',
    });

    expect(beginRes.status).toBe(200);
    expect(beginRes.body.session_dir).toContain('config-test-session');
    expect(beginRes.body.expires_at).toBeDefined();

    // Verify env file was rendered with the credential from config
    const sessionDir = beginRes.body.session_dir;
    const envContent = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
    expect(envContent).toContain('TEST_SECRET=');

    // Clean up session
    const endRes = await request(controlSocketPath, 'DELETE', '/sessions/config-test-session');
    expect(endRes.status).toBe(200);
  });

  it('configLoader.loadRole throws ROLE_NOT_FOUND for unknown role', async () => {
    const agencyDir = path.join(tmpDir, '.agency');
    await createValidAgencyDir(agencyDir);

    const controlSocketPath = path.join(tmpDir, 'control.sock');
    const sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const config = buildDaemonConfig(agencyDir, controlSocketPath, sessionsDir);
    daemon = new Daemon(config);
    await daemon.start();

    // Request a nonexistent role
    const res = await request(controlSocketPath, 'POST', '/sessions', {
      role: 'nonexistent-role',
      session_id: 'bad-role-session',
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROLE_NOT_FOUND');
  });
});

describe('Integration: Config Loading (Invalid Config)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-badcfg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('loadConfig throws ConfigValidationError for role referencing nonexistent credential', () => {
    const agencyDir = path.join(tmpDir, '.agency');
    const secretsDir = path.join(agencyDir, 'secrets');
    const rolesDir = path.join(agencyDir, 'roles');

    mkdirSync(secretsDir, { recursive: true });
    mkdirSync(rolesDir, { recursive: true });

    writeFileSync(path.join(secretsDir, 'backends.yaml'), VALID_BACKENDS_YAML);
    writeFileSync(path.join(secretsDir, 'credentials.yaml'), VALID_CREDENTIALS_YAML);
    writeFileSync(path.join(rolesDir, 'bad-role.yaml'), INVALID_ROLE_YAML);

    expect(() => loadConfig({ agencyDir })).toThrow('Config validation failed');
  });

  it('loadConfig throws ConfigValidationError for missing required backends.yaml', () => {
    const agencyDir = path.join(tmpDir, '.agency-missing');
    const secretsDir = path.join(agencyDir, 'secrets');

    mkdirSync(secretsDir, { recursive: true });

    // No backends.yaml or credentials.yaml — both are required
    expect(() => loadConfig({ agencyDir })).toThrow('Config validation failed');
  });

  it('daemon binary exits non-zero with invalid config', async () => {
    const agencyDir = path.join(tmpDir, '.agency');
    const secretsDir = path.join(agencyDir, 'secrets');
    const rolesDir = path.join(agencyDir, 'roles');
    await fs.mkdir(secretsDir, { recursive: true });
    await fs.mkdir(rolesDir, { recursive: true });

    await fs.writeFile(path.join(secretsDir, 'backends.yaml'), VALID_BACKENDS_YAML);
    await fs.writeFile(path.join(secretsDir, 'credentials.yaml'), VALID_CREDENTIALS_YAML);
    await fs.writeFile(path.join(rolesDir, 'bad-role.yaml'), INVALID_ROLE_YAML);

    // Spawn the daemon binary as a child process using the compiled JS output
    const binPath = path.resolve(__dirname, '../../dist/bin/credhelper-daemon.js');

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        'node',
        [binPath],
        {
          env: {
            ...process.env,
            CREDHELPER_AGENCY_DIR: agencyDir,
            CREDHELPER_CONTROL_SOCKET: path.join(tmpDir, 'test-control.sock'),
            CREDHELPER_SESSIONS_DIR: path.join(tmpDir, 'test-sessions'),
          },
          timeout: 10000,
        },
        (error, _stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stderr: stderr || '',
          });
        },
      );
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Config validation failed');
  });
});
