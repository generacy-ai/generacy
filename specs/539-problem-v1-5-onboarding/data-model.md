# Data Model: Concurrent Local Clusters

## Modified Types

### `ServiceStatus` (status/formatter.ts)

**Current**:
```ts
export const ServiceStatusSchema = z.object({
  name: z.string(),
  state: ContainerStateSchema,
  status: z.string(),
});
```

**New** — add optional `ports` field:
```ts
export const PortMappingSchema = z.object({
  containerPort: z.number(),
  hostPort: z.number(),
  protocol: z.string().default('tcp'),
});

export const ServiceStatusSchema = z.object({
  name: z.string(),
  state: ContainerStateSchema,
  status: z.string(),
  ports: z.array(PortMappingSchema).default([]),
});
```

### `ClusterStatus` (status/formatter.ts)

**New** — add optional `hostPort` for convenience:
```ts
export const ClusterStatusSchema = z.object({
  // ...existing fields...
  hostPort: z.number().nullable(), // Host port mapped to container 3100
});
```

`hostPort` is derived from the first service's `ports` array entry where `containerPort === 3100`.

## Unchanged Types

### `ScaffoldComposeInput` (cluster/scaffolder.ts)
No schema change needed. The `deploymentMode` field already exists and controls the port behavior.

### `RegistryEntry` (cluster/registry.ts)
No schema change. Ports are queried live from Docker, not cached in the registry.

### `ClusterContext` (cluster/context.ts)
No schema change.

## Docker Compose YAML Structure

### Before (scaffolded output)
```yaml
services:
  cluster:
    ports:
      - "3100:3100"
      - "3101:3101"
      - "3102:3102"
```

### After — local mode (default)
```yaml
services:
  cluster:
    ports:
      - "3100"
```

### After — cloud/deploy mode
```yaml
services:
  cluster:
    ports:
      - "3100:3100"
```

## Docker ps JSON Shape (input, not owned by us)

```ts
// Shape of objects from `docker compose ps --format json`
interface DockerComposePsEntry {
  Name: string;
  Service: string;
  State: string;
  Status: string;
  Publishers: Array<{
    URL: string;       // e.g. "0.0.0.0"
    TargetPort: number;     // container port
    PublishedPort: number;  // host port
    Protocol: string;       // "tcp" or "udp"
  }>;
}
```

## Legacy Port Detection

A compose file has "legacy" ports if any entry in `services.cluster.ports` matches the `HOST:CONTAINER` pattern (contains `:`). Detection is string-based on the parsed YAML array.

```ts
function hasLegacyPorts(ports: unknown[]): boolean {
  return ports.some((p) => typeof p === 'string' && p.includes(':'));
}
```
