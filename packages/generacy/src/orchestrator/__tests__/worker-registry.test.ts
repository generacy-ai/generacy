import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WorkerRegistry } from '../worker-registry.js';
import type { WorkerRegistration, Heartbeat } from '../types.js';

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new WorkerRegistry({ heartbeatTimeout: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('register', () => {
    it('should register a worker with provided ID', async () => {
      const registration: WorkerRegistration = {
        id: 'worker-1',
        name: 'Test Worker',
        capabilities: ['task-a', 'task-b'],
        maxConcurrent: 2,
      };

      const workerId = await registry.register(registration);

      expect(workerId).toBe('worker-1');
      const worker = registry.getWorker('worker-1');
      expect(worker).toBeDefined();
      expect(worker?.name).toBe('Test Worker');
      expect(worker?.capabilities).toEqual(['task-a', 'task-b']);
      expect(worker?.maxConcurrent).toBe(2);
      expect(worker?.status).toBe('healthy');
      expect(worker?.currentJobs).toEqual([]);
    });

    it('should generate ID when not provided', async () => {
      const registration = {
        id: '',
        name: 'Auto ID Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      } as WorkerRegistration;

      const workerId = await registry.register(registration);

      expect(workerId).toBeTruthy();
      expect(workerId).not.toBe('');
      const worker = registry.getWorker(workerId);
      expect(worker).toBeDefined();
      expect(worker?.name).toBe('Auto ID Worker');
    });

    it('should use default capabilities when not provided', async () => {
      const registration = {
        id: 'worker-default-caps',
        name: 'Default Caps Worker',
        capabilities: undefined as unknown as string[],
        maxConcurrent: 1,
      } as WorkerRegistration;

      const workerId = await registry.register(registration);
      const worker = registry.getWorker(workerId);

      expect(worker?.capabilities).toEqual(['*']);
    });

    it('should use default maxConcurrent when not provided', async () => {
      const registration = {
        id: 'worker-default-concurrent',
        name: 'Default Concurrent Worker',
        capabilities: ['task-a'],
        maxConcurrent: undefined as unknown as number,
      } as WorkerRegistration;

      const workerId = await registry.register(registration);
      const worker = registry.getWorker(workerId);

      expect(worker?.maxConcurrent).toBe(1);
    });

    it('should register worker with healthEndpoint and metadata', async () => {
      const registration: WorkerRegistration = {
        id: 'worker-full',
        name: 'Full Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
        healthEndpoint: 'http://localhost:8080/health',
        metadata: { version: '1.0.0', region: 'us-west' },
      };

      const workerId = await registry.register(registration);
      const worker = registry.getWorker(workerId);

      expect(worker?.healthEndpoint).toBe('http://localhost:8080/health');
      expect(worker?.metadata).toEqual({ version: '1.0.0', region: 'us-west' });
    });

    it('should set registeredAt timestamp on registration', async () => {
      const now = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(now);

      const registration: WorkerRegistration = {
        id: 'worker-timestamp',
        name: 'Timestamp Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      };

      await registry.register(registration);
      const worker = registry.getWorker('worker-timestamp');

      expect(worker?.registeredAt).toEqual(now);
      expect(worker?.lastHeartbeat).toEqual(now);
    });
  });

  describe('unregister', () => {
    it('should remove a registered worker', async () => {
      const registration: WorkerRegistration = {
        id: 'worker-to-remove',
        name: 'Worker to Remove',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      };

      await registry.register(registration);
      expect(registry.getWorker('worker-to-remove')).toBeDefined();

      await registry.unregister('worker-to-remove');
      expect(registry.getWorker('worker-to-remove')).toBeUndefined();
    });

    it('should not throw when unregistering non-existent worker', async () => {
      await expect(registry.unregister('non-existent')).resolves.not.toThrow();
    });
  });

  describe('heartbeat', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-hb',
        name: 'Heartbeat Worker',
        capabilities: ['task-a'],
        maxConcurrent: 2,
      });
    });

    it('should process heartbeat and return acknowledged', async () => {
      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb',
        status: 'idle',
        timestamp: new Date().toISOString(),
      };

      const response = await registry.heartbeat('worker-hb', heartbeatData);

      expect(response.acknowledged).toBe(true);
    });

    it('should update lastHeartbeat timestamp', async () => {
      const initialTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(initialTime);

      await registry.register({
        id: 'worker-hb-time',
        name: 'HB Time Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      const laterTime = new Date('2024-01-15T10:05:00Z');
      vi.setSystemTime(laterTime);

      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb-time',
        status: 'idle',
        timestamp: laterTime.toISOString(),
      };

      await registry.heartbeat('worker-hb-time', heartbeatData);
      const worker = registry.getWorker('worker-hb-time');

      expect(worker?.lastHeartbeat).toEqual(laterTime);
    });

    it('should set worker status to healthy on heartbeat', async () => {
      const worker = registry.getWorker('worker-hb');
      // Manually set to unhealthy to test reset
      if (worker) {
        worker.status = 'unhealthy';
      }

      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb',
        status: 'busy',
        timestamp: new Date().toISOString(),
      };

      await registry.heartbeat('worker-hb', heartbeatData);
      expect(registry.getWorker('worker-hb')?.status).toBe('healthy');
    });

    it('should add currentJob from heartbeat data', async () => {
      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb',
        status: 'busy',
        currentJob: 'job-123',
        timestamp: new Date().toISOString(),
      };

      await registry.heartbeat('worker-hb', heartbeatData);
      const worker = registry.getWorker('worker-hb');

      expect(worker?.currentJobs).toContain('job-123');
    });

    it('should not duplicate currentJob if already tracked', async () => {
      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb',
        status: 'busy',
        currentJob: 'job-123',
        timestamp: new Date().toISOString(),
      };

      await registry.heartbeat('worker-hb', heartbeatData);
      await registry.heartbeat('worker-hb', heartbeatData);

      const worker = registry.getWorker('worker-hb');
      const jobCount = worker?.currentJobs.filter((j) => j === 'job-123').length;
      expect(jobCount).toBe(1);
    });

    it('should clear currentJobs when worker is idle', async () => {
      // First, add a job
      registry.assignJob('worker-hb', 'job-123');
      expect(registry.getWorker('worker-hb')?.currentJobs).toContain('job-123');

      // Then send idle heartbeat
      const heartbeatData: Heartbeat = {
        workerId: 'worker-hb',
        status: 'idle',
        timestamp: new Date().toISOString(),
      };

      await registry.heartbeat('worker-hb', heartbeatData);
      expect(registry.getWorker('worker-hb')?.currentJobs).toEqual([]);
    });

    it('should return acknowledged: false for unknown worker', async () => {
      const heartbeatData: Heartbeat = {
        workerId: 'unknown-worker',
        status: 'idle',
        timestamp: new Date().toISOString(),
      };

      const response = await registry.heartbeat('unknown-worker', heartbeatData);

      expect(response.acknowledged).toBe(false);
    });
  });

  describe('getWorker', () => {
    it('should get worker by ID', async () => {
      await registry.register({
        id: 'worker-get',
        name: 'Get Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      const worker = registry.getWorker('worker-get');

      expect(worker).toBeDefined();
      expect(worker?.id).toBe('worker-get');
      expect(worker?.name).toBe('Get Worker');
    });

    it('should return undefined for non-existent worker', () => {
      const worker = registry.getWorker('non-existent');
      expect(worker).toBeUndefined();
    });
  });

  describe('getIdleWorkers', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-idle-1',
        name: 'Idle Worker 1',
        capabilities: ['task-a'],
        maxConcurrent: 2,
      });
      await registry.register({
        id: 'worker-idle-2',
        name: 'Idle Worker 2',
        capabilities: ['task-b'],
        maxConcurrent: 1,
      });
    });

    it('should return healthy workers with capacity', () => {
      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(2);
      expect(idleWorkers.map((w) => w.id)).toContain('worker-idle-1');
      expect(idleWorkers.map((w) => w.id)).toContain('worker-idle-2');
    });

    it('should exclude workers at max capacity', () => {
      const worker = registry.getWorker('worker-idle-2');
      if (worker) {
        worker.currentJobs = ['job-1']; // maxConcurrent is 1
      }

      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(1);
      expect(idleWorkers[0].id).toBe('worker-idle-1');
    });

    it('should exclude unhealthy workers', () => {
      const worker = registry.getWorker('worker-idle-1');
      if (worker) {
        worker.status = 'unhealthy';
      }

      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(1);
      expect(idleWorkers[0].id).toBe('worker-idle-2');
    });

    it('should exclude offline workers', () => {
      const worker = registry.getWorker('worker-idle-1');
      if (worker) {
        worker.status = 'offline';
      }

      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(1);
      expect(idleWorkers[0].id).toBe('worker-idle-2');
    });

    it('should return empty array when no idle workers', () => {
      // Set all workers to not be idle
      const worker1 = registry.getWorker('worker-idle-1');
      const worker2 = registry.getWorker('worker-idle-2');
      if (worker1) worker1.status = 'unhealthy';
      if (worker2) worker2.currentJobs = ['job-1'];

      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(0);
    });

    it('should include worker with partial capacity', () => {
      const worker = registry.getWorker('worker-idle-1');
      if (worker) {
        worker.currentJobs = ['job-1']; // maxConcurrent is 2, so still has capacity
      }

      const idleWorkers = registry.getIdleWorkers();

      expect(idleWorkers).toHaveLength(2);
      expect(idleWorkers.map((w) => w.id)).toContain('worker-idle-1');
    });
  });

  describe('checkTimeouts', () => {
    let onWorkerOffline: ReturnType<typeof vi.fn>;
    let onWorkerUnhealthy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      onWorkerOffline = vi.fn();
      onWorkerUnhealthy = vi.fn();
      registry = new WorkerRegistry({
        heartbeatTimeout: 1000,
        onWorkerOffline,
        onWorkerUnhealthy,
      });
    });

    it('should mark worker unhealthy after timeout', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-timeout',
        name: 'Timeout Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      // Advance time past heartbeat timeout (1000ms)
      vi.setSystemTime(new Date(startTime.getTime() + 1500));

      await registry.checkTimeouts();

      const worker = registry.getWorker('worker-timeout');
      expect(worker?.status).toBe('unhealthy');
      expect(onWorkerUnhealthy).toHaveBeenCalledWith('worker-timeout');
    });

    it('should mark worker offline after 2x timeout', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-offline',
        name: 'Offline Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      // Advance time past 2x heartbeat timeout (2000ms)
      vi.setSystemTime(new Date(startTime.getTime() + 2500));

      const offlineWorkerIds = await registry.checkTimeouts();

      const worker = registry.getWorker('worker-offline');
      expect(worker?.status).toBe('offline');
      expect(offlineWorkerIds).toContain('worker-offline');
      expect(onWorkerOffline).toHaveBeenCalledWith('worker-offline');
    });

    it('should return array of workers that went offline', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-1',
        name: 'Worker 1',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-2',
        name: 'Worker 2',
        capabilities: ['task-b'],
        maxConcurrent: 1,
      });

      vi.setSystemTime(new Date(startTime.getTime() + 2500));

      const offlineWorkerIds = await registry.checkTimeouts();

      expect(offlineWorkerIds).toHaveLength(2);
      expect(offlineWorkerIds).toContain('worker-1');
      expect(offlineWorkerIds).toContain('worker-2');
    });

    it('should not re-trigger callback for already offline worker', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-already-offline',
        name: 'Already Offline Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      vi.setSystemTime(new Date(startTime.getTime() + 2500));

      await registry.checkTimeouts();
      expect(onWorkerOffline).toHaveBeenCalledTimes(1);

      // Check timeouts again
      vi.setSystemTime(new Date(startTime.getTime() + 5000));
      await registry.checkTimeouts();

      // Should not be called again
      expect(onWorkerOffline).toHaveBeenCalledTimes(1);
    });

    it('should not mark healthy worker as unhealthy if within timeout', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-healthy',
        name: 'Healthy Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      // Advance time but stay within timeout
      vi.setSystemTime(new Date(startTime.getTime() + 500));

      await registry.checkTimeouts();

      const worker = registry.getWorker('worker-healthy');
      expect(worker?.status).toBe('healthy');
      expect(onWorkerUnhealthy).not.toHaveBeenCalled();
    });

    it('should transition from unhealthy to offline', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await registry.register({
        id: 'worker-transition',
        name: 'Transition Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      // First, go unhealthy
      vi.setSystemTime(new Date(startTime.getTime() + 1500));
      await registry.checkTimeouts();
      expect(registry.getWorker('worker-transition')?.status).toBe('unhealthy');
      expect(onWorkerUnhealthy).toHaveBeenCalledTimes(1);

      // Then, go offline
      vi.setSystemTime(new Date(startTime.getTime() + 2500));
      await registry.checkTimeouts();
      expect(registry.getWorker('worker-transition')?.status).toBe('offline');
      expect(onWorkerOffline).toHaveBeenCalledTimes(1);
    });
  });

  describe('assignJob', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-assign',
        name: 'Assign Worker',
        capabilities: ['task-a'],
        maxConcurrent: 2,
      });
    });

    it('should assign job to worker', () => {
      const result = registry.assignJob('worker-assign', 'job-1');

      expect(result).toBe(true);
      expect(registry.getWorker('worker-assign')?.currentJobs).toContain('job-1');
    });

    it('should respect maxConcurrent limit', () => {
      registry.assignJob('worker-assign', 'job-1');
      registry.assignJob('worker-assign', 'job-2');

      const result = registry.assignJob('worker-assign', 'job-3');

      expect(result).toBe(false);
      expect(registry.getWorker('worker-assign')?.currentJobs).toHaveLength(2);
      expect(registry.getWorker('worker-assign')?.currentJobs).not.toContain('job-3');
    });

    it('should return false for unknown worker', () => {
      const result = registry.assignJob('unknown-worker', 'job-1');
      expect(result).toBe(false);
    });

    it('should not duplicate job if already assigned', () => {
      registry.assignJob('worker-assign', 'job-1');
      registry.assignJob('worker-assign', 'job-1');

      const worker = registry.getWorker('worker-assign');
      expect(worker?.currentJobs.filter((j) => j === 'job-1')).toHaveLength(1);
    });

    it('should allow assignment up to maxConcurrent', async () => {
      await registry.register({
        id: 'worker-multi',
        name: 'Multi Worker',
        capabilities: ['task-a'],
        maxConcurrent: 3,
      });

      expect(registry.assignJob('worker-multi', 'job-1')).toBe(true);
      expect(registry.assignJob('worker-multi', 'job-2')).toBe(true);
      expect(registry.assignJob('worker-multi', 'job-3')).toBe(true);
      expect(registry.assignJob('worker-multi', 'job-4')).toBe(false);

      expect(registry.getWorker('worker-multi')?.currentJobs).toHaveLength(3);
    });
  });

  describe('unassignJob', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-unassign',
        name: 'Unassign Worker',
        capabilities: ['task-a'],
        maxConcurrent: 2,
      });
      registry.assignJob('worker-unassign', 'job-1');
      registry.assignJob('worker-unassign', 'job-2');
    });

    it('should remove job from worker', () => {
      registry.unassignJob('worker-unassign', 'job-1');

      const worker = registry.getWorker('worker-unassign');
      expect(worker?.currentJobs).not.toContain('job-1');
      expect(worker?.currentJobs).toContain('job-2');
    });

    it('should not throw when unassigning non-existent job', () => {
      expect(() => registry.unassignJob('worker-unassign', 'non-existent-job')).not.toThrow();
    });

    it('should not throw when unassigning from unknown worker', () => {
      expect(() => registry.unassignJob('unknown-worker', 'job-1')).not.toThrow();
    });

    it('should allow new assignments after unassignment', () => {
      registry.unassignJob('worker-unassign', 'job-1');

      const result = registry.assignJob('worker-unassign', 'job-3');

      expect(result).toBe(true);
      expect(registry.getWorker('worker-unassign')?.currentJobs).toContain('job-3');
    });
  });

  describe('findWorkersWithCapability', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-cap-a',
        name: 'Worker A',
        capabilities: ['task-a', 'task-b'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-cap-b',
        name: 'Worker B',
        capabilities: ['task-b', 'task-c'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-cap-all',
        name: 'Worker All',
        capabilities: ['*'],
        maxConcurrent: 1,
      });
    });

    it('should find workers matching capability', () => {
      const workers = registry.findWorkersWithCapability('task-a');

      expect(workers).toHaveLength(2);
      expect(workers.map((w) => w.id)).toContain('worker-cap-a');
      expect(workers.map((w) => w.id)).toContain('worker-cap-all');
    });

    it('should return workers with wildcard capability', () => {
      const workers = registry.findWorkersWithCapability('task-unknown');

      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('worker-cap-all');
    });

    it('should return multiple workers with same capability', () => {
      const workers = registry.findWorkersWithCapability('task-b');

      expect(workers).toHaveLength(3);
      expect(workers.map((w) => w.id)).toContain('worker-cap-a');
      expect(workers.map((w) => w.id)).toContain('worker-cap-b');
      expect(workers.map((w) => w.id)).toContain('worker-cap-all');
    });

    it('should return empty array when no workers match', async () => {
      // Create registry without wildcard worker
      const newRegistry = new WorkerRegistry({ heartbeatTimeout: 1000 });
      await newRegistry.register({
        id: 'worker-specific',
        name: 'Specific Worker',
        capabilities: ['task-x'],
        maxConcurrent: 1,
      });

      const workers = newRegistry.findWorkersWithCapability('task-y');

      expect(workers).toHaveLength(0);
    });

    it('should include unhealthy and offline workers in results', () => {
      const workerA = registry.getWorker('worker-cap-a');
      const workerB = registry.getWorker('worker-cap-b');
      if (workerA) workerA.status = 'unhealthy';
      if (workerB) workerB.status = 'offline';

      const workers = registry.findWorkersWithCapability('task-b');

      expect(workers).toHaveLength(3);
    });
  });

  describe('getAllWorkers', () => {
    it('should return all registered workers', async () => {
      await registry.register({
        id: 'worker-all-1',
        name: 'Worker All 1',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-all-2',
        name: 'Worker All 2',
        capabilities: ['task-b'],
        maxConcurrent: 2,
      });

      const allWorkers = registry.getAllWorkers();

      expect(allWorkers).toHaveLength(2);
      expect(allWorkers.map((w) => w.id)).toContain('worker-all-1');
      expect(allWorkers.map((w) => w.id)).toContain('worker-all-2');
    });

    it('should return empty array when no workers registered', () => {
      const allWorkers = registry.getAllWorkers();
      expect(allWorkers).toHaveLength(0);
    });
  });

  describe('getWorkerCounts', () => {
    beforeEach(async () => {
      await registry.register({
        id: 'worker-count-1',
        name: 'Worker 1',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-count-2',
        name: 'Worker 2',
        capabilities: ['task-b'],
        maxConcurrent: 1,
      });
      await registry.register({
        id: 'worker-count-3',
        name: 'Worker 3',
        capabilities: ['task-c'],
        maxConcurrent: 1,
      });
    });

    it('should return correct counts for all statuses', () => {
      const worker2 = registry.getWorker('worker-count-2');
      const worker3 = registry.getWorker('worker-count-3');
      if (worker2) worker2.status = 'unhealthy';
      if (worker3) worker3.status = 'offline';

      const counts = registry.getWorkerCounts();

      expect(counts.healthy).toBe(1);
      expect(counts.unhealthy).toBe(1);
      expect(counts.offline).toBe(1);
      expect(counts.total).toBe(3);
    });

    it('should return all zeros when no workers', () => {
      const emptyRegistry = new WorkerRegistry({ heartbeatTimeout: 1000 });
      const counts = emptyRegistry.getWorkerCounts();

      expect(counts.healthy).toBe(0);
      expect(counts.unhealthy).toBe(0);
      expect(counts.offline).toBe(0);
      expect(counts.total).toBe(0);
    });

    it('should count all as healthy initially', () => {
      const counts = registry.getWorkerCounts();

      expect(counts.healthy).toBe(3);
      expect(counts.unhealthy).toBe(0);
      expect(counts.offline).toBe(0);
      expect(counts.total).toBe(3);
    });
  });

  describe('default options', () => {
    it('should use default heartbeat timeout of 60000ms', async () => {
      const defaultRegistry = new WorkerRegistry();
      const startTime = new Date('2024-01-15T10:00:00Z');
      vi.setSystemTime(startTime);

      await defaultRegistry.register({
        id: 'worker-default-timeout',
        name: 'Default Timeout Worker',
        capabilities: ['task-a'],
        maxConcurrent: 1,
      });

      // Advance time just under default timeout (60000ms)
      vi.setSystemTime(new Date(startTime.getTime() + 59000));
      await defaultRegistry.checkTimeouts();
      expect(defaultRegistry.getWorker('worker-default-timeout')?.status).toBe('healthy');

      // Advance time past default timeout
      vi.setSystemTime(new Date(startTime.getTime() + 61000));
      await defaultRegistry.checkTimeouts();
      expect(defaultRegistry.getWorker('worker-default-timeout')?.status).toBe('unhealthy');
    });
  });
});
