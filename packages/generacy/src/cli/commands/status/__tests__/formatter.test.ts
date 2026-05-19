import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveState, formatTable, formatJson, type ClusterStatus, type ServiceStatus } from '../formatter.js';

// ---------------------------------------------------------------------------
// deriveState
// ---------------------------------------------------------------------------

describe('deriveState', () => {
  it('returns "missing" when services is empty', () => {
    expect(deriveState([])).toBe('missing');
  });

  it('returns "running" when all services are running', () => {
    const services: ServiceStatus[] = [
      { name: 'web', state: 'running', status: 'Up 5 minutes' },
      { name: 'worker', state: 'running', status: 'Up 5 minutes' },
    ];
    expect(deriveState(services)).toBe('running');
  });

  it('returns "stopped" when all services are stopped', () => {
    const services: ServiceStatus[] = [
      { name: 'web', state: 'stopped', status: '' },
      { name: 'worker', state: 'stopped', status: '' },
    ];
    expect(deriveState(services)).toBe('stopped');
  });

  it('returns "stopped" when all services are exited', () => {
    const services: ServiceStatus[] = [
      { name: 'web', state: 'exited', status: 'Exited (0)' },
      { name: 'worker', state: 'exited', status: 'Exited (0)' },
    ];
    expect(deriveState(services)).toBe('stopped');
  });

  it('returns "partial" when mix of running and stopped', () => {
    const services: ServiceStatus[] = [
      { name: 'web', state: 'running', status: 'Up 5 minutes' },
      { name: 'worker', state: 'stopped', status: '' },
    ];
    expect(deriveState(services)).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe('formatTable', () => {
  it('returns "No clusters registered." when empty', () => {
    expect(formatTable([])).toBe('No clusters registered.');
  });

  it('returns formatted table with header for non-empty', () => {
    const statuses: ClusterStatus[] = [
      {
        clusterId: 'cls-1',
        name: 'my-app',
        path: '/projects/my-app',
        variant: 'standard',
        channel: 'stable',
        state: 'running',
        services: [{ name: 'web', state: 'running', status: 'Up 5 minutes', ports: [] }],
        hostPort: null,
        lastSeen: '2026-04-29T00:00:00.000Z',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ];

    const result = formatTable(statuses);
    const lines = result.split('\n');

    // Header row
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Cluster ID');
    expect(lines[0]).toContain('State');
    expect(lines[0]).toContain('Port');
    expect(lines[0]).toContain('Variant');
    expect(lines[0]).toContain('Channel');
    expect(lines[0]).toContain('Path');

    // Separator
    expect(lines[1]).toMatch(/^[-| ]+$/);

    // Data row
    expect(lines[2]).toContain('my-app');
    expect(lines[2]).toContain('cls-1');
    expect(lines[2]).toContain('running');
    expect(lines[2]).toContain('standard');
    expect(lines[2]).toContain('stable');
    expect(lines[2]).toContain('/projects/my-app');
  });

  it('includes Port column with host port value', () => {
    const statuses: ClusterStatus[] = [
      {
        clusterId: 'cls-1',
        name: 'my-app',
        path: '/projects/my-app',
        variant: 'standard',
        channel: 'stable',
        state: 'running',
        services: [{ name: 'web', state: 'running', status: 'Up 5 minutes', ports: [{ containerPort: 3100, hostPort: 49201, protocol: 'tcp' }] }],
        hostPort: 49201,
        lastSeen: '2026-04-29T00:00:00.000Z',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ];

    const result = formatTable(statuses);
    expect(result).toContain('49201');
  });

  it('shows "N/A" when hostPort is null', () => {
    const statuses: ClusterStatus[] = [
      {
        clusterId: 'cls-1',
        name: 'my-app',
        path: '/projects/my-app',
        variant: 'standard',
        channel: 'stable',
        state: 'stopped',
        services: [],
        hostPort: null,
        lastSeen: '2026-04-29T00:00:00.000Z',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ];

    const result = formatTable(statuses);
    expect(result).toContain('N/A');
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------

describe('formatJson', () => {
  it('returns valid JSON string with hostPort field', () => {
    const statuses: ClusterStatus[] = [
      {
        clusterId: 'cls-1',
        name: 'my-app',
        path: '/projects/my-app',
        variant: 'standard',
        channel: 'stable',
        state: 'running',
        services: [],
        hostPort: 49201,
        lastSeen: '2026-04-29T00:00:00.000Z',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ];

    const result = formatJson(statuses);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(statuses);
    expect(parsed[0].hostPort).toBe(49201);
  });
});
