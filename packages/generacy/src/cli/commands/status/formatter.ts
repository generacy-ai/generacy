import { z } from 'zod';

export const ContainerStateSchema = z.enum([
  'running',
  'stopped',
  'exited',
  'paused',
  'restarting',
  'dead',
  'created',
]);

export const ServiceStatusSchema = z.object({
  name: z.string(),
  state: ContainerStateSchema,
  status: z.string(),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const ClusterStatusSchema = z.object({
  clusterId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  variant: z.string(),
  channel: z.string(),
  state: z.enum(['running', 'stopped', 'partial', 'missing']),
  services: z.array(ServiceStatusSchema),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;

export function deriveState(services: ServiceStatus[]): 'running' | 'stopped' | 'partial' | 'missing' {
  if (services.length === 0) return 'missing';
  const allRunning = services.every((s) => s.state === 'running');
  if (allRunning) return 'running';
  const allStopped = services.every((s) => s.state === 'stopped' || s.state === 'exited');
  if (allStopped) return 'stopped';
  return 'partial';
}

export function formatTable(statuses: ClusterStatus[]): string {
  if (statuses.length === 0) {
    return 'No clusters registered.';
  }

  const header = ['Name', 'Cluster ID', 'State', 'Variant', 'Channel', 'Path'];
  const rows = statuses.map((s) => [
    s.name,
    s.clusterId ?? '(pending)',
    s.state,
    s.variant,
    s.channel,
    s.path,
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );

  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const formatRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join(' | ');

  return [formatRow(header), sep, ...rows.map(formatRow)].join('\n');
}

export function formatJson(statuses: ClusterStatus[]): string {
  return JSON.stringify(statuses, null, 2);
}
