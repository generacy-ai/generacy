import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveGeneracyDir } from './project-dir-resolver.js';
import { DockerEngineClient } from './docker-engine-client.js';
import {
  type ContainerInspect,
  type ContainerCreateBody,
  type ContainerState,
  type NetworkEndpointCreate,
  DockerEngineError,
} from './docker-engine-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScaleOptions {
  /** Target worker count. Must be >= 1 (validated upstream in lifecycle route). */
  count: number;
  /** Override orchestrator URL for metadata-refresh callback. */
  orchestratorUrl?: string;
  /** Override orchestrator internal API key. */
  orchestratorApiKey?: string;
  /** Override Docker socket. Default: env DOCKER_HOST or unix:///var/run/docker-host.sock. */
  dockerHost?: string;
  /** Override engine client (test seam — production wires the default). */
  engineClient?: DockerEngineClient;
}

export interface ScaleResult {
  /** Worker count observed before scaling (from Engine API enumeration, not .env). */
  previousCount: number;
  /** Target count from ScaleOptions.count. */
  requestedCount: number;
  /** Actual achieved count after the operation. Equals requestedCount on success. */
  actualCount: number;
}

export class PartialScaleError extends Error {
  override readonly name = 'PartialScaleError';
  readonly requested: number;
  readonly actual: number;
  readonly previousCount: number;
  override readonly cause: Error;

  constructor(requested: number, actual: number, previousCount: number, cause: Error) {
    super(`Partial scale: requested ${requested}, achieved ${actual} (${cause.message})`);
    this.requested = requested;
    this.actual = actual;
    this.previousCount = previousCount;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface WorkerReplica {
  id: string;
  number: number;
  name: string;
  state: ContainerState;
  networkIds: string[];
}

export interface ScalePlan {
  toCreate: number[];
  toRemove: string[];
}

// ---------------------------------------------------------------------------
// Module-level async mutex (FR-014, Q4=A).
//
// Promise-chain pattern from research.md §"In-process mutex" — serializes
// concurrent scaleWorkers() calls within this process. The second caller
// waits for the first to complete, then operates on the post-first state.
// ---------------------------------------------------------------------------

let inflight: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Plan container-number assignment for a scale operation.
 *
 * Scale up: gap-fill ascending in [1..max(existing)], then append.
 * Scale down: sort exited (highest-numbered first), then running (highest-numbered first),
 *             take the first (current - target) IDs.
 * No-op: returns `{ toCreate: [], toRemove: [] }`.
 *
 * Pure function — unit-tested independently. FR-006, SC-003, SC-011.
 */
export function assignContainerNumbers(existing: WorkerReplica[], target: number): ScalePlan {
  const current = existing.length;
  if (current === target) {
    return { toCreate: [], toRemove: [] };
  }

  if (target > current) {
    // Scale up
    const numbersInUse = new Set(existing.map((r) => r.number));
    const max = existing.length === 0 ? 0 : Math.max(...numbersInUse);
    const toCreate: number[] = [];

    // Gap-fill ascending within [1..max].
    for (let n = 1; n <= max; n++) {
      if (toCreate.length >= target - current) break;
      if (!numbersInUse.has(n)) toCreate.push(n);
    }
    // Append above max until target reached.
    for (let n = max + 1; toCreate.length < target - current; n++) {
      toCreate.push(n);
    }

    return { toCreate, toRemove: [] };
  }

  // Scale down: exited first (highest-numbered first), then running (highest-numbered first).
  const exited = existing
    .filter((r) => r.state !== 'running')
    .sort((a, b) => b.number - a.number);
  const running = existing
    .filter((r) => r.state === 'running')
    .sort((a, b) => b.number - a.number);
  const ordered = [...exited, ...running];
  const toRemove = ordered.slice(0, current - target).map((r) => r.id);

  return { toCreate: [], toRemove };
}

/**
 * Clone a source replica's inspect response into a create body for a new replica.
 *
 * Strips orchestrator-set fields (Id, Created, State, Status, Hostname, populated
 * NetworkSettings) and keeps Image, Cmd, Env, Entrypoint, WorkingDir, User, Labels,
 * Healthcheck, StopSignal, StopTimeout, ExposedPorts, and all of HostConfig.
 *
 * Overwrites the `com.docker.compose.container-number` label with the new number —
 * preserves all other labels (project, service, config-hash, etc.) per FR-007.
 *
 * Builds NetworkingConfig with **first network only** from source.NetworkSettings.Networks
 * in insertion order. Caller is responsible for `connectNetwork` calls for remaining
 * networks before `startContainer` (Q1=A multi-network sequencing).
 *
 * Throws `Error('SOURCE_REPLICA_HAS_NO_NETWORKS')` if source has zero networks.
 */
export function cloneInspectToCreate(
  inspect: ContainerInspect,
  newNumber: number,
  _newName: string,
): ContainerCreateBody {
  const networkEntries = Object.entries(inspect.NetworkSettings.Networks);
  if (networkEntries.length === 0) {
    throw new Error('SOURCE_REPLICA_HAS_NO_NETWORKS');
  }
  const [firstNetworkName, firstEndpoint] = networkEntries[0]!;

  const labels: Record<string, string> = { ...(inspect.Config.Labels ?? {}) };
  labels['com.docker.compose.container-number'] = String(newNumber);

  const firstEndpointConfig: NetworkEndpointCreate = {};
  if (firstEndpoint.Aliases) firstEndpointConfig.Aliases = firstEndpoint.Aliases;
  if (firstEndpoint.IPAMConfig?.IPv4Address) {
    firstEndpointConfig.IPAMConfig = { IPv4Address: firstEndpoint.IPAMConfig.IPv4Address };
  }

  const body: ContainerCreateBody = {
    Image: inspect.Image,
    HostConfig: inspect.HostConfig,
    NetworkingConfig: { EndpointsConfig: { [firstNetworkName]: firstEndpointConfig } },
    Labels: labels,
  };

  // Carry through optional config fields verbatim.
  if (inspect.Config.User !== undefined) body.User = inspect.Config.User;
  if (inspect.Config.Env !== undefined) body.Env = inspect.Config.Env;
  if (inspect.Config.Cmd !== undefined) body.Cmd = inspect.Config.Cmd;
  if (inspect.Config.Entrypoint !== undefined) body.Entrypoint = inspect.Config.Entrypoint;
  if (inspect.Config.WorkingDir !== undefined) body.WorkingDir = inspect.Config.WorkingDir;
  if (inspect.Config.Healthcheck !== undefined) body.Healthcheck = inspect.Config.Healthcheck;
  if (inspect.Config.StopSignal !== undefined) body.StopSignal = inspect.Config.StopSignal;
  if (inspect.Config.StopTimeout !== undefined) body.StopTimeout = inspect.Config.StopTimeout;
  if (inspect.Config.ExposedPorts !== undefined) body.ExposedPorts = inspect.Config.ExposedPorts;
  // Hostname is intentionally NOT carried through — Docker derives it from the
  // container name when absent, which avoids collisions across clones.

  return body;
}

// ---------------------------------------------------------------------------
// Engine orchestration helpers
// ---------------------------------------------------------------------------

/**
 * Discover the compose project name by inspecting the orchestrator's own
 * container. Falls back to COMPOSE_PROJECT_NAME env var. Throws if neither
 * resolves — happens when running outside compose (dev mode, raw docker run).
 */
export async function computeProjectName(client: DockerEngineClient): Promise<string> {
  const selfHostname = hostname();
  try {
    const inspect = await client.inspectContainer(selfHostname);
    const project = inspect.Config.Labels?.['com.docker.compose.project'];
    if (project) return project;
  } catch {
    // Hostname may not be the container ID (e.g. when overridden in compose).
  }

  const envProject = process.env['COMPOSE_PROJECT_NAME'];
  if (envProject) return envProject;

  throw new Error('ORCHESTRATOR_NOT_COMPOSE_MANAGED');
}

/**
 * Enumerate worker containers for the given compose project. Includes
 * stopped/exited replicas (FR-002, Q3=A). Containers with missing or
 * non-numeric `com.docker.compose.container-number` labels are skipped
 * with a warning — defensive against manually-added containers.
 */
export async function enumerateWorkers(
  client: DockerEngineClient,
  project: string,
): Promise<WorkerReplica[]> {
  const summaries = await client.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${project}`,
        'com.docker.compose.service=worker',
      ],
    },
  });

  const replicas: WorkerReplica[] = [];
  for (const summary of summaries) {
    const numberLabel = summary.Labels?.['com.docker.compose.container-number'];
    const parsedNumber = numberLabel ? parseInt(numberLabel, 10) : NaN;
    if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
      console.warn(
        `[worker-scaler] skipping container ${summary.Id} with missing/invalid container-number label: ${numberLabel ?? '<none>'}`,
      );
      continue;
    }
    const networkIds = summary.NetworkSettings?.Networks
      ? Object.values(summary.NetworkSettings.Networks).map((n) => n.NetworkID)
      : [];
    // `Names` arrives with a leading '/' from Engine — strip for readability.
    const rawName = summary.Names[0] ?? '';
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    replicas.push({
      id: summary.Id,
      number: parsedNumber,
      name,
      state: summary.State,
      networkIds,
    });
  }

  return replicas;
}

interface ScaleUpResult {
  created: number[];
  failed?: { number: number; error: Error };
}

interface ScaleDownResult {
  removed: string[];
  failed?: { id: string; error: Error };
}

/**
 * Create + connect-extra-networks + start, repeated per toCreate slot.
 *
 * Per-slot sequencing (Q1=A):
 *   1. Pre-check gap-fill name collision (FR-015, Q5=A) — if any container
 *      already holds `<project>-worker-<n>`, force-remove it first. Edge
 *      case after manual `docker rm` of a running worker; normal operation
 *      doesn't trigger it because exited replicas are counted by FR-002.
 *   2. POST /containers/create with the first network in NetworkingConfig.
 *   3. POST /networks/<id>/connect per additional network from source.
 *   4. POST /containers/<id>/start.
 *
 * On the first error, stop the loop and return `{ created, failed }`. Do NOT
 * roll back already-created replicas (Q2=B: commit what succeeded).
 */
export async function scaleUp(
  client: DockerEngineClient,
  project: string,
  source: ContainerInspect,
  toCreate: number[],
): Promise<ScaleUpResult> {
  const created: number[] = [];
  // Source network order is daemon-authoritative (insertion order). The first
  // network goes into NetworkingConfig at create time; the rest are attached
  // via connectNetwork before start.
  const sourceNetworkEntries = Object.entries(source.NetworkSettings.Networks);
  const extraNetworks = sourceNetworkEntries.slice(1);

  for (const number of toCreate) {
    const name = `${project}-worker-${number}`;
    try {
      // Pre-check for stale container holding the target name.
      const conflicts = await client.listContainers({
        all: true,
        filters: { name: [name] },
      });
      for (const conflict of conflicts) {
        // Docker's name filter is substring-match — narrow to exact match.
        const exactMatch = conflict.Names.some(
          (n) => n === `/${name}` || n === name,
        );
        if (!exactMatch) continue;
        await client.removeContainer(conflict.Id, { force: true });
      }

      const body = cloneInspectToCreate(source, number, name);
      const createResult = await client.createContainer(name, body);

      // Attach remaining networks before start so workloads see full membership.
      for (const [, endpoint] of extraNetworks) {
        const connectBody: { Container: string; EndpointConfig?: NetworkEndpointCreate } = {
          Container: createResult.Id,
        };
        const endpointConfig: NetworkEndpointCreate = {};
        if (endpoint.Aliases) endpointConfig.Aliases = endpoint.Aliases;
        if (endpoint.IPAMConfig?.IPv4Address) {
          endpointConfig.IPAMConfig = { IPv4Address: endpoint.IPAMConfig.IPv4Address };
        }
        if (Object.keys(endpointConfig).length > 0) {
          connectBody.EndpointConfig = endpointConfig;
        }
        await client.connectNetwork(endpoint.NetworkID, connectBody);
      }

      await client.startContainer(createResult.Id);
      created.push(number);
    } catch (err) {
      return {
        created,
        failed: { number, error: err instanceof Error ? err : new Error(String(err)) },
      };
    }
  }

  return { created };
}

/**
 * Stop + remove per ID, in the caller-provided order (already sorted by
 * `assignContainerNumbers`: exited first, then running, highest-numbered first).
 * On the first error, stop and return `{ removed, failed }`. (FR-004)
 */
export async function scaleDown(
  client: DockerEngineClient,
  toRemoveIds: string[],
): Promise<ScaleDownResult> {
  const removed: string[] = [];
  for (const id of toRemoveIds) {
    try {
      await client.stopContainer(id);
      await client.removeContainer(id);
      removed.push(id);
    } catch (err) {
      return {
        removed,
        failed: { id, error: err instanceof Error ? err : new Error(String(err)) },
      };
    }
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Main entry: scaleWorkers
// ---------------------------------------------------------------------------

/**
 * Scale worker replicas to the requested count via the Docker Engine API.
 *
 * Replaces the previous `docker compose --scale` shell-out: enumerates workers
 * by `com.docker.compose.*` labels, clones an existing replica's config, and
 * issues create/connect/start or stop/remove directly on the daemon. Removes
 * the host compose-file dependency entirely.
 *
 * Concurrent invocations are serialized by an in-process async mutex (FR-014).
 *
 * Stale clone drift case (FR-013): if a user edits the host compose file and
 * rebuilds without `docker compose up -d`, scale-up clones a stale source
 * replica's config — same behavior as compose itself when scaling from an
 * older replica. Documented here per the spec; not actionable in this code path.
 */
export async function scaleWorkers(options: ScaleOptions): Promise<ScaleResult> {
  const previous = inflight;
  let resolveNext!: (v: unknown) => void;
  inflight = new Promise((r) => {
    resolveNext = r;
  });
  await previous;
  try {
    return await doScale(options);
  } finally {
    resolveNext(undefined);
  }
}

async function doScale(options: ScaleOptions): Promise<ScaleResult> {
  const { count } = options;
  const orchestratorUrl =
    options.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100';
  const orchestratorApiKey =
    options.orchestratorApiKey ?? process.env['ORCHESTRATOR_INTERNAL_API_KEY'];

  const dockerHostOption = options.dockerHost;
  const client = options.engineClient ?? new DockerEngineClient(
    dockerHostOption !== undefined ? { dockerHost: dockerHostOption } : {},
  );

  const project = await computeProjectName(client);
  const existing = await enumerateWorkers(client, project);
  const previousCount = existing.length;

  // No-op short-circuit: no Engine mutations, no cluster.yaml write, no metadata refresh.
  if (previousCount === count) {
    return { previousCount, requestedCount: count, actualCount: previousCount };
  }

  const plan = assignContainerNumbers(existing, count);

  let scaleUpResult: ScaleUpResult = { created: [] };
  let scaleDownResult: ScaleDownResult = { removed: [] };
  let cause: Error | null = null;

  if (plan.toCreate.length > 0) {
    // Clone source: first existing replica (any state — even an exited replica
    // carries a complete inspect record).
    const sourceReplica = existing[0]!;
    const source = await client.inspectContainer(sourceReplica.id);
    scaleUpResult = await scaleUp(client, project, source, plan.toCreate);
    if (scaleUpResult.failed) cause = scaleUpResult.failed.error;
  } else if (plan.toRemove.length > 0) {
    scaleDownResult = await scaleDown(client, plan.toRemove);
    if (scaleDownResult.failed) cause = scaleDownResult.failed.error;
  }

  const actualCount =
    previousCount + scaleUpResult.created.length - scaleDownResult.removed.length;
  const madeProgress =
    scaleUpResult.created.length > 0 || scaleDownResult.removed.length > 0;

  if (cause && !madeProgress) {
    // Full failure: no replicas created/removed. cluster.yaml NOT updated,
    // metadata refresh NOT fired. Throw the underlying error directly so the
    // route handler can map it (e.g. DockerDaemonUnavailableError → 503).
    throw cause;
  }

  // Persist runtime worker count on any progress, including partial. Atomic
  // temp+rename. Writes to cluster.local.yaml (git-ignored) to avoid mutating
  // the template-owned, git-tracked cluster.yaml (#709).
  const generacyDir = await resolveGeneracyDir();
  const localYamlPath = join(generacyDir, 'cluster.local.yaml');
  await updateClusterLocalYaml(localYamlPath, actualCount);

  // Best-effort: keep .env's WORKER_COUNT in sync so host-side `docker compose
  // up -d` doesn't undo the scale on the next re-up. Failures are non-blocking
  // (cluster.yaml is the source of truth and the CLI re-derivation step will
  // reconcile .env on the next `npx generacy up` / `update`). See #708.
  const envPath = join(generacyDir, '.env');
  try {
    await syncEnvWorkerCountInScaler(envPath, actualCount);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      console.warn(
        `[worker-scaler] WORKER_COUNT sync to .env skipped: file not found at ${envPath}`,
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worker-scaler] WORKER_COUNT sync to .env failed: ${msg}; cluster.yaml is the source of truth`,
      );
    }
  }

  if (orchestratorApiKey) {
    triggerMetadataRefresh(orchestratorUrl, orchestratorApiKey).catch(() => {
      // Non-fatal: metadata will refresh on the next periodic cycle.
    });
  }

  if (cause) {
    throw new PartialScaleError(count, actualCount, previousCount, cause);
  }

  return { previousCount, requestedCount: count, actualCount };
}

// ---------------------------------------------------------------------------
// Preserved helpers
// ---------------------------------------------------------------------------

/**
 * Update the `workers` field in cluster.local.yaml atomically.
 * Creates the file if absent. Preserves any other top-level fields already
 * present.
 */
export async function updateClusterLocalYaml(localYamlPath: string, count: number): Promise<void> {
  let doc: Record<string, unknown>;
  try {
    const content = await readFile(localYamlPath, 'utf-8');
    doc = (parseYaml(content) as Record<string, unknown>) ?? {};
  } catch {
    doc = {};
  }

  doc.workers = count;
  const output = stringifyYaml(doc);
  await atomicWrite(localYamlPath, output);
}

/**
 * POST to orchestrator /internal/refresh-metadata to trigger immediate metadata push.
 */
export async function triggerMetadataRefresh(
  orchestratorUrl: string,
  apiKey: string,
): Promise<void> {
  const response = await fetch(`${orchestratorUrl}/internal/refresh-metadata`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`refresh-metadata returned ${response.status}`);
  }
}

/**
 * Atomic file write: write to temp file, then rename. Temp file is created in
 * the target directory (not os.tmpdir) so rename(2) stays on a single filesystem.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(targetPath), `.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(tmpPath, content, { mode: 0o644 });
  await rename(tmpPath, targetPath);
}

/**
 * Rewrite `WORKER_COUNT=<count>` in .env. Throws ENOENT if .env is missing
 * (caller treats that as a skip-and-warn). Other errors propagate to the
 * caller's catch and are logged as failures. The CLI re-derivation path in
 * `worker-count-deriver.ts` is the symmetric implementation on the host side.
 */
async function syncEnvWorkerCountInScaler(envPath: string, count: number): Promise<void> {
  await stat(envPath); // throws ENOENT if missing — caller logs the skip
  const existing = await readFile(envPath, 'utf-8');
  const line = `WORKER_COUNT=${count}`;
  const pattern = /^WORKER_COUNT=.*$/m;
  let next: string;
  if (pattern.test(existing)) {
    next = existing.replace(pattern, line);
  } else if (existing.length === 0) {
    next = `${line}\n`;
  } else {
    next = existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`;
  }
  await atomicWrite(envPath, next);
}

// Re-export so existing tests can import from this module.
export { DockerEngineError };
