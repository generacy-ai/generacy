import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/services/project-dir-resolver.js', () => ({
  resolveGeneracyDir: vi.fn(),
}));

import {
  assignContainerNumbers,
  cloneInspectToCreate,
  scaleWorkers,
  updateClusterYaml,
  PartialScaleError,
  type WorkerReplica,
} from '../../src/services/worker-scaler.js';
import type {
  ContainerInspect,
  ContainerSummary,
  ContainerCreateBody,
  NetworkConnectBody,
} from '../../src/services/docker-engine-types.js';
import { resolveGeneracyDir } from '../../src/services/project-dir-resolver.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeReplica(
  number: number,
  state: WorkerReplica['state'] = 'running',
  overrides: Partial<WorkerReplica> = {},
): WorkerReplica {
  return {
    id: overrides.id ?? `id-${number}`,
    number,
    name: overrides.name ?? `proj-worker-${number}`,
    state,
    networkIds: overrides.networkIds ?? [`net-${number}`],
  };
}

function makeInspect(overrides: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: 'src-id',
    Name: '/proj-worker-1',
    Image: 'worker-image:latest',
    Config: {
      Hostname: 'oldhostname',
      User: '1000:1000',
      Env: ['FOO=bar'],
      Cmd: ['node', 'worker.js'],
      Labels: {
        'com.docker.compose.project': 'proj',
        'com.docker.compose.service': 'worker',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.config-hash': 'h1',
      },
      WorkingDir: '/app',
      Healthcheck: { Test: ['CMD', 'true'] },
      ExposedPorts: { '3000/tcp': {} },
    },
    HostConfig: {
      Binds: ['/host:/container'],
      NetworkMode: 'mynet',
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkSettings: {
      Networks: {
        mynet: {
          NetworkID: 'net-mynet',
          Aliases: ['worker'],
          IPAddress: '172.20.0.5',
          IPAMConfig: { IPv4Address: '172.20.0.5' },
        },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake DockerEngineClient — records every call and lets tests script outcomes.
// ---------------------------------------------------------------------------

interface FakeClientCall {
  method: string;
  args: unknown[];
}

class FakeDockerEngineClient {
  calls: FakeClientCall[] = [];
  containers: Map<string, ContainerInspect> = new Map();
  /** Override for listContainers. Default returns enumerateWorkers fixture. */
  listResult: ContainerSummary[] = [];
  /** Optional handler for collision pre-check (filters.name lookups). */
  nameLookup: Map<string, ContainerSummary[]> = new Map();
  /** Per-method failure injection. */
  failOn: {
    createContainer?: (callNumber: number, name: string) => Error | null;
    startContainer?: (callNumber: number, id: string) => Error | null;
    stopContainer?: (callNumber: number, id: string) => Error | null;
    removeContainer?: (callNumber: number, id: string) => Error | null;
    connectNetwork?: (callNumber: number, networkId: string) => Error | null;
  } = {};

  private callCounts: Record<string, number> = {};

  async listContainers(opts: {
    all?: boolean;
    filters?: Record<string, string[]>;
  } = {}): Promise<ContainerSummary[]> {
    this.calls.push({ method: 'listContainers', args: [opts] });
    // Name-collision precheck path.
    if (opts.filters?.['name']) {
      const queriedName = opts.filters['name'][0];
      return this.nameLookup.get(queriedName!) ?? [];
    }
    return this.listResult;
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    this.calls.push({ method: 'inspectContainer', args: [id] });
    const inspect = this.containers.get(id);
    if (!inspect) {
      throw new Error(`inspectContainer: no fixture for id=${id}`);
    }
    return inspect;
  }

  async createContainer(
    name: string,
    body: ContainerCreateBody,
  ): Promise<{ Id: string; Warnings?: string[] }> {
    const n = (this.callCounts['createContainer'] = (this.callCounts['createContainer'] ?? 0) + 1);
    this.calls.push({ method: 'createContainer', args: [name, body] });
    const err = this.failOn.createContainer?.(n, name);
    if (err) throw err;
    return { Id: `created-${n}` };
  }

  async startContainer(id: string): Promise<void> {
    const n = (this.callCounts['startContainer'] = (this.callCounts['startContainer'] ?? 0) + 1);
    this.calls.push({ method: 'startContainer', args: [id] });
    const err = this.failOn.startContainer?.(n, id);
    if (err) throw err;
  }

  async stopContainer(id: string): Promise<void> {
    const n = (this.callCounts['stopContainer'] = (this.callCounts['stopContainer'] ?? 0) + 1);
    this.calls.push({ method: 'stopContainer', args: [id] });
    const err = this.failOn.stopContainer?.(n, id);
    if (err) throw err;
  }

  async removeContainer(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const n = (this.callCounts['removeContainer'] = (this.callCounts['removeContainer'] ?? 0) + 1);
    this.calls.push({ method: 'removeContainer', args: [id, opts] });
    const err = this.failOn.removeContainer?.(n, id);
    if (err) throw err;
  }

  async connectNetwork(networkId: string, body: NetworkConnectBody): Promise<void> {
    const n = (this.callCounts['connectNetwork'] = (this.callCounts['connectNetwork'] ?? 0) + 1);
    this.calls.push({ method: 'connectNetwork', args: [networkId, body] });
    const err = this.failOn.connectNetwork?.(n, networkId);
    if (err) throw err;
  }

  callsTo(method: string): FakeClientCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/**
 * Build the listContainers response for the orchestrator's "computeProjectName"
 * self-inspect AND the worker enumeration query. The self-inspect uses
 * `inspectContainer(<hostname>)`; we route it through `containers` map.
 */
function seedComputeProjectName(client: FakeDockerEngineClient, project: string): void {
  // computeProjectName -> inspectContainer(os.hostname())
  // We just put the inspect under any id and re-route via a wildcard:
  // simpler approach is to set COMPOSE_PROJECT_NAME env var (the fallback path).
  // We do that in beforeEach below.
  void client;
  void project;
}

/** Convert worker replicas to ContainerSummary objects for listContainers. */
function replicasToSummaries(replicas: WorkerReplica[]): ContainerSummary[] {
  return replicas.map((r) => ({
    Id: r.id,
    Names: [`/${r.name}`],
    Labels: {
      'com.docker.compose.project': 'proj',
      'com.docker.compose.service': 'worker',
      'com.docker.compose.container-number': String(r.number),
    },
    State: r.state,
    NetworkSettings: {
      Networks: Object.fromEntries(
        r.networkIds.map((nid, i) => [`net${i}`, { NetworkID: nid }]),
      ),
    },
  }));
}

// ---------------------------------------------------------------------------
// assignContainerNumbers (T007 — pure helper)
// ---------------------------------------------------------------------------

describe('assignContainerNumbers', () => {
  it('empty → 3 creates [1,2,3]', () => {
    const plan = assignContainerNumbers([], 3);
    expect(plan.toCreate).toEqual([1, 2, 3]);
    expect(plan.toRemove).toEqual([]);
  });

  it('[1,2,3] → 5 appends [4,5] (no gap)', () => {
    const existing = [makeReplica(1), makeReplica(2), makeReplica(3)];
    const plan = assignContainerNumbers(existing, 5);
    expect(plan.toCreate).toEqual([4, 5]);
    expect(plan.toRemove).toEqual([]);
  });

  it('[1,3] → 4 gap-fills (creates [2,4])', () => {
    const existing = [makeReplica(1), makeReplica(3)];
    const plan = assignContainerNumbers(existing, 4);
    expect(plan.toCreate).toEqual([2, 4]);
    expect(plan.toRemove).toEqual([]);
  });

  it('[1,4] → 5 fills gaps first then appends ([2,3,5])', () => {
    const existing = [makeReplica(1), makeReplica(4)];
    const plan = assignContainerNumbers(existing, 5);
    expect(plan.toCreate).toEqual([2, 3, 5]);
  });

  it('[1,2,3] → 1 removes highest-numbered first (#3 then #2)', () => {
    const existing = [makeReplica(1), makeReplica(2), makeReplica(3)];
    const plan = assignContainerNumbers(existing, 1);
    expect(plan.toRemove).toEqual([
      existing[2]!.id, // #3
      existing[1]!.id, // #2
    ]);
    expect(plan.toCreate).toEqual([]);
  });

  it('exited #2 + running [1,3] → 1 removes exited first then running #3', () => {
    const existing = [
      makeReplica(1, 'running'),
      makeReplica(2, 'exited'),
      makeReplica(3, 'running'),
    ];
    const plan = assignContainerNumbers(existing, 1);
    // Order: exited #2 first, then running #3.
    expect(plan.toRemove).toEqual([existing[1]!.id, existing[2]!.id]);
  });

  it('no-op [1,2] → 2 returns empty plan', () => {
    const existing = [makeReplica(1), makeReplica(2)];
    const plan = assignContainerNumbers(existing, 2);
    expect(plan).toEqual({ toCreate: [], toRemove: [] });
  });
});

// ---------------------------------------------------------------------------
// cloneInspectToCreate (T008 — pure helper)
// ---------------------------------------------------------------------------

describe('cloneInspectToCreate', () => {
  it('single-network source produces single-entry EndpointsConfig', () => {
    const inspect = makeInspect();
    const body = cloneInspectToCreate(inspect, 2, 'proj-worker-2');
    expect(Object.keys(body.NetworkingConfig.EndpointsConfig)).toEqual(['mynet']);
  });

  it('multi-network source produces single-entry EndpointsConfig with first network', () => {
    const inspect = makeInspect({
      NetworkSettings: {
        Networks: {
          first: { NetworkID: 'net-first' },
          second: { NetworkID: 'net-second' },
          third: { NetworkID: 'net-third' },
        },
      },
    });
    const body = cloneInspectToCreate(inspect, 2, 'proj-worker-2');
    expect(Object.keys(body.NetworkingConfig.EndpointsConfig)).toEqual(['first']);
  });

  it('zero-network source throws SOURCE_REPLICA_HAS_NO_NETWORKS', () => {
    const inspect = makeInspect({ NetworkSettings: { Networks: {} } });
    expect(() => cloneInspectToCreate(inspect, 2, 'proj-worker-2')).toThrow(
      'SOURCE_REPLICA_HAS_NO_NETWORKS',
    );
  });

  it('overwrites container-number label, preserves config-hash and project/service labels', () => {
    const inspect = makeInspect();
    const body = cloneInspectToCreate(inspect, 5, 'proj-worker-5');
    expect(body.Labels?.['com.docker.compose.container-number']).toBe('5');
    expect(body.Labels?.['com.docker.compose.config-hash']).toBe('h1');
    expect(body.Labels?.['com.docker.compose.project']).toBe('proj');
    expect(body.Labels?.['com.docker.compose.service']).toBe('worker');
  });

  it('strips Hostname (Docker derives it from container name)', () => {
    const inspect = makeInspect();
    const body = cloneInspectToCreate(inspect, 2, 'proj-worker-2');
    expect(body.Hostname).toBeUndefined();
  });

  it('carries through Image, HostConfig, Env, Cmd, WorkingDir, Healthcheck', () => {
    const inspect = makeInspect();
    const body = cloneInspectToCreate(inspect, 2, 'proj-worker-2');
    expect(body.Image).toBe('worker-image:latest');
    expect(body.HostConfig).toEqual(inspect.HostConfig);
    expect(body.Env).toEqual(['FOO=bar']);
    expect(body.Cmd).toEqual(['node', 'worker.js']);
    expect(body.WorkingDir).toBe('/app');
    expect(body.Healthcheck).toEqual({ Test: ['CMD', 'true'] });
  });
});

// ---------------------------------------------------------------------------
// Orchestration tests (T020–T025)
// ---------------------------------------------------------------------------

describe('scaleWorkers (orchestration)', () => {
  let tempDir: string;
  let client: FakeDockerEngineClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worker-scaler-test-'));
    vi.mocked(resolveGeneracyDir).mockResolvedValue(tempDir);
    // Use COMPOSE_PROJECT_NAME env fallback so computeProjectName resolves
    // without needing to mock the orchestrator self-inspect.
    process.env['COMPOSE_PROJECT_NAME'] = 'proj';
    client = new FakeDockerEngineClient();
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    // Seed a cluster.yaml so updateClusterYaml works against an existing file.
    writeFileSync(join(tempDir, 'cluster.yaml'), 'channel: stable\nworkers: 1\n');
  });

  afterEach(() => {
    delete process.env['COMPOSE_PROJECT_NAME'];
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('happy paths', () => {
    it('1 → 3 scale-up: clones source, creates 2 replicas, starts each', async () => {
      const source = makeReplica(1);
      client.listResult = replicasToSummaries([source]);
      client.containers.set(source.id, makeInspect());

      const result = await scaleWorkers({
        count: 3,
        engineClient: client as never,
        orchestratorApiKey: 'k',
      });

      expect(result.previousCount).toBe(1);
      expect(result.requestedCount).toBe(3);
      expect(result.actualCount).toBe(3);

      // computeProjectName makes a self-inspect (throws, falls back to env), then
      // we inspect the source replica once.
      const inspectCalls = client.callsTo('inspectContainer');
      // Filter out the self-inspect calls (they receive the os.hostname() id).
      const sourceInspects = inspectCalls.filter((c) => c.args[0] === source.id);
      expect(sourceInspects).toHaveLength(1);
      // Two creates with the gap-filled / appended numbers (2, 3).
      const creates = client.callsTo('createContainer');
      expect(creates).toHaveLength(2);
      expect(creates[0]!.args[0]).toBe('proj-worker-2');
      expect(creates[1]!.args[0]).toBe('proj-worker-3');
      // Two starts (one per created container).
      expect(client.callsTo('startContainer')).toHaveLength(2);
      // No connectNetwork (single-network source).
      expect(client.callsTo('connectNetwork')).toHaveLength(0);

      // cluster.yaml updated.
      const yaml = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      expect(yaml).toContain('workers: 3');
      // metadata refresh fired.
      expect(mockFetch).toHaveBeenCalled();
    });

    it('gap-fill scale-up [1,3] → 4 creates [2,4]', async () => {
      const replicas = [makeReplica(1), makeReplica(3)];
      client.listResult = replicasToSummaries(replicas);
      client.containers.set(replicas[0]!.id, makeInspect());

      const result = await scaleWorkers({
        count: 4,
        engineClient: client as never,
      });
      expect(result.actualCount).toBe(4);
      const created = client.callsTo('createContainer').map((c) => c.args[0]);
      expect(created).toEqual(['proj-worker-2', 'proj-worker-4']);
    });

    it('3 → 1 scale-down: highest-numbered running removed first', async () => {
      const replicas = [makeReplica(1), makeReplica(2), makeReplica(3)];
      client.listResult = replicasToSummaries(replicas);

      const result = await scaleWorkers({
        count: 1,
        engineClient: client as never,
      });
      expect(result.previousCount).toBe(3);
      expect(result.actualCount).toBe(1);

      // Two stop/remove pairs in order: #3 then #2.
      const stops = client.callsTo('stopContainer');
      const removes = client.callsTo('removeContainer');
      expect(stops).toHaveLength(2);
      expect(removes).toHaveLength(2);
      expect(stops[0]!.args[0]).toBe(replicas[2]!.id); // #3
      expect(stops[1]!.args[0]).toBe(replicas[1]!.id); // #2

      const yaml = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      expect(yaml).toContain('workers: 1');
    });

    it('no-op: no Engine mutations, no cluster.yaml write, no metadata refresh', async () => {
      const replicas = [makeReplica(1), makeReplica(2)];
      client.listResult = replicasToSummaries(replicas);

      const before = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      const result = await scaleWorkers({
        count: 2,
        engineClient: client as never,
        orchestratorApiKey: 'k',
      });
      expect(result.actualCount).toBe(2);
      expect(result.previousCount).toBe(2);

      // No create/start/stop/remove calls.
      expect(client.callsTo('createContainer')).toHaveLength(0);
      expect(client.callsTo('stopContainer')).toHaveLength(0);
      expect(client.callsTo('startContainer')).toHaveLength(0);
      expect(client.callsTo('removeContainer')).toHaveLength(0);
      // cluster.yaml unchanged.
      const after = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      expect(after).toBe(before);
      // No metadata refresh.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('multi-network source: each new replica gets create + connect per extra network + start', async () => {
      const source = makeReplica(1);
      client.listResult = replicasToSummaries([source]);
      const multiNetworkInspect = makeInspect({
        NetworkSettings: {
          Networks: {
            primary: { NetworkID: 'net-primary' },
            secondary: { NetworkID: 'net-secondary' },
            tertiary: { NetworkID: 'net-tertiary' },
          },
        },
      });
      client.containers.set(source.id, multiNetworkInspect);

      await scaleWorkers({
        count: 3,
        engineClient: client as never,
      });

      // 2 creates (one per new replica)
      expect(client.callsTo('createContainer')).toHaveLength(2);
      // Each create followed by 2 connectNetwork calls (for secondary + tertiary).
      const connects = client.callsTo('connectNetwork');
      expect(connects).toHaveLength(4); // 2 replicas × 2 extra networks
      // Verify the network IDs are the extras (not the first one already in NetworkingConfig).
      const connectedNets = connects.map((c) => c.args[0]);
      expect(connectedNets).toEqual([
        'net-secondary',
        'net-tertiary',
        'net-secondary',
        'net-tertiary',
      ]);
      // 2 starts
      expect(client.callsTo('startContainer')).toHaveLength(2);
    });
  });

  describe('partial-failure (T021)', () => {
    it('1→5 with createContainer failing on 3rd call throws PartialScaleError(5,3)', async () => {
      const source = makeReplica(1);
      client.listResult = replicasToSummaries([source]);
      client.containers.set(source.id, makeInspect());
      client.failOn.createContainer = (n) =>
        n === 3 ? new Error('docker create boom') : null;

      await expect(
        scaleWorkers({
          count: 5,
          engineClient: client as never,
          orchestratorApiKey: 'k',
        }),
      ).rejects.toMatchObject({
        name: 'PartialScaleError',
        requested: 5,
        actual: 3, // 1 existing + 2 successful creates (calls 1 and 2 succeed; #3 fails)
      });

      // cluster.yaml reflects actualCount = 3.
      const yaml = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      expect(yaml).toContain('workers: 3');
      // Metadata refresh fired (partial counts as progress).
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('full-failure (T022)', () => {
    it('1→5 with createContainer failing on 1st call throws plain Error, no yaml/refresh', async () => {
      const source = makeReplica(1);
      client.listResult = replicasToSummaries([source]);
      client.containers.set(source.id, makeInspect());
      client.failOn.createContainer = () => new Error('docker create boom');

      const yamlBefore = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');

      await expect(
        scaleWorkers({
          count: 5,
          engineClient: client as never,
          orchestratorApiKey: 'k',
        }),
      ).rejects.toThrowError('docker create boom');

      // Verify a non-PartialScaleError (the underlying engine error bubbles up).
      try {
        await scaleWorkers({
          count: 5,
          engineClient: client as never,
          orchestratorApiKey: 'k',
        });
      } catch (err) {
        expect(err).not.toBeInstanceOf(PartialScaleError);
        expect((err as Error).name).not.toBe('PartialScaleError');
      }

      // cluster.yaml unchanged.
      const yamlAfter = readFileSync(join(tempDir, 'cluster.yaml'), 'utf-8');
      expect(yamlAfter).toBe(yamlBefore);
      // No metadata refresh.
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('exited-replica counting (T023, FR-002, Q3=A)', () => {
    it('on scale-down, exited #2 removed first then running #3', async () => {
      const replicas = [
        makeReplica(1, 'running'),
        makeReplica(2, 'exited'),
        makeReplica(3, 'running'),
      ];
      client.listResult = replicasToSummaries(replicas);

      await scaleWorkers({
        count: 1,
        engineClient: client as never,
      });

      const stops = client.callsTo('stopContainer');
      expect(stops[0]!.args[0]).toBe(replicas[1]!.id); // exited #2 first
      expect(stops[1]!.args[0]).toBe(replicas[2]!.id); // running #3 second
    });

    it('on scale-up, exited #2 counts as existing — gap-fill targets [4]', async () => {
      const replicas = [
        makeReplica(1, 'running'),
        makeReplica(2, 'exited'),
        makeReplica(3, 'running'),
      ];
      client.listResult = replicasToSummaries(replicas);
      client.containers.set(replicas[0]!.id, makeInspect());

      await scaleWorkers({
        count: 4,
        engineClient: client as never,
      });

      const created = client.callsTo('createContainer').map((c) => c.args[0]);
      // previousCount=3, target=4 → toCreate=[4] (no gap because #2 exists as exited).
      expect(created).toEqual(['proj-worker-4']);
    });
  });

  describe('concurrency / mutex (T024, FR-014)', () => {
    it('two parallel scale calls are serialized; second sees first as previousCount', async () => {
      // Initial state: 1 replica.
      let currentReplicas: WorkerReplica[] = [makeReplica(1)];
      client.containers.set(currentReplicas[0]!.id, makeInspect());

      // Each listContainers reflects the post-previous-call state.
      let createdSoFar = 0;
      const origListContainers = client.listContainers.bind(client);
      client.listContainers = async (opts: {
        all?: boolean;
        filters?: Record<string, string[]>;
      } = {}) => {
        // Re-route name-collision precheck — return [].
        if (opts.filters?.['name']) return origListContainers(opts);
        return replicasToSummaries(currentReplicas);
      };

      const origCreate = client.createContainer.bind(client);
      client.createContainer = async (name: string, body: ContainerCreateBody) => {
        createdSoFar += 1;
        // Use ascending IDs reflecting "real" creation.
        const newId = `dyn-${createdSoFar}`;
        const newNumber = parseInt(name.split('-').pop()!, 10);
        currentReplicas = [
          ...currentReplicas,
          makeReplica(newNumber, 'running', { id: newId }),
        ];
        return origCreate(name, body);
      };

      // Capture results in order they resolve.
      const p1 = scaleWorkers({ count: 3, engineClient: client as never });
      const p2 = scaleWorkers({ count: 5, engineClient: client as never });
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.previousCount).toBe(1);
      expect(r1.actualCount).toBe(3);
      expect(r2.previousCount).toBe(3); // observed first call's post-state
      expect(r2.actualCount).toBe(5);

      // No duplicate container-number across all createContainer calls.
      const createdNames = client.callsTo('createContainer').map((c) => c.args[0] as string);
      const numbers = createdNames.map((n) => parseInt(n.split('-').pop()!, 10));
      const uniq = new Set(numbers);
      expect(uniq.size).toBe(numbers.length);
    });
  });

  describe('gap-fill name-collision (T025, FR-015, Q5=A)', () => {
    it('force-removes stale container holding target name before create', async () => {
      const replicas = [makeReplica(1), makeReplica(3)];
      client.listResult = replicasToSummaries(replicas);
      client.containers.set(replicas[0]!.id, makeInspect());

      // Stopped container is squatting on `proj-worker-2`.
      const staleId = 'stale-2';
      client.nameLookup.set('proj-worker-2', [
        {
          Id: staleId,
          Names: ['/proj-worker-2'],
          Labels: {},
          State: 'exited',
        },
      ]);
      // proj-worker-4 has no conflict.
      client.nameLookup.set('proj-worker-4', []);

      await scaleWorkers({
        count: 4,
        engineClient: client as never,
      });

      // Assert force-remove called with the stale id before create #2.
      const removeCalls = client.callsTo('removeContainer');
      expect(removeCalls.some((c) =>
        c.args[0] === staleId && (c.args[1] as { force?: boolean }).force === true,
      )).toBe(true);

      // The removeContainer must happen before the corresponding createContainer.
      // (Verify by call order in the unified `calls` log.)
      const removeIdx = client.calls.findIndex(
        (c) => c.method === 'removeContainer' && c.args[0] === staleId,
      );
      const createIdx = client.calls.findIndex(
        (c) => c.method === 'createContainer' && c.args[0] === 'proj-worker-2',
      );
      expect(removeIdx).toBeLessThan(createIdx);
    });
  });
});

// ---------------------------------------------------------------------------
// Preserved helper: updateClusterYaml smoke tests (kept from prior version)
// ---------------------------------------------------------------------------

describe('updateClusterYaml', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worker-scaler-yaml-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates existing workers field', async () => {
    const yamlPath = join(tempDir, 'cluster.yaml');
    writeFileSync(yamlPath, 'channel: stable\nworkers: 1\nvariant: cluster-base\n');

    await updateClusterYaml(yamlPath, 5);

    const content = readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('workers: 5');
    expect(content).toContain('channel: stable');
    expect(content).toContain('variant: cluster-base');
  });

  it('creates cluster.yaml when it does not exist', async () => {
    const yamlPath = join(tempDir, 'cluster.yaml');
    expect(existsSync(yamlPath)).toBe(false);

    await updateClusterYaml(yamlPath, 2);

    const content = readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('workers: 2');
  });
});
