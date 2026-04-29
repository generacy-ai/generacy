# Implementation Plan: CLI Package Skeleton & Cluster Registry

**Feature**: Public npx CLI skeleton with placeholder subcommands, cluster registry, and Node version gate
**Branch**: `493-context-v1-5-introduces`
**Status**: Complete

## Summary

This feature extends the existing `@generacy-ai/generacy` CLI at `packages/generacy/src/cli/` with 11 placeholder subcommands for v1.5 cluster lifecycle (`launch`, `up`, `stop`, `down`, `destroy`, `status`, `update`, `open`, `claude-login`, `deploy`, `rebuild`), a `~/.generacy/clusters.json` registry helper for tracking local clusters, a Node >=22 version gate, and a global error handler. Publishing uses the existing changeset pipeline — no new workflow required.

## Technical Context

### Language & Framework
- **Runtime**: Node.js 22+ (enforced by version gate)
- **Language**: TypeScript 5.4+ with strict mode
- **Module System**: ESM (`"type": "module"`)
- **Testing**: Vitest

### Dependencies (already present)
| Package | Version | Purpose |
|---------|---------|---------|
| commander | ^12.0.0 | CLI framework |
| pino | ^9.0.0 | Structured logging |
| pino-pretty | ^11.0.0 | Dev-friendly log output |
| zod | ^3.23.0 | Schema validation for clusters.json |

### New Dependencies
None. All requirements can be met with existing deps and Node built-ins (`node:fs`, `node:path`, `node:os`).

### Internal Dependencies
None beyond the existing `@generacy-ai/generacy` package internals.

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/493-context-v1-5-introduces/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Clarification answers
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Registry schema & types
└── quickstart.md        # Usage guide
```

### Source Code (repository root)

```text
packages/generacy/
├── bin/
│   └── generacy.js                          # Add Node version check before import
├── src/
│   ├── cli/
│   │   ├── index.ts                         # MODIFY: register placeholder commands, add quiet flag
│   │   ├── commands/
│   │   │   ├── placeholders.ts              # NEW: all 11 placeholder subcommands factory
│   │   │   └── ... (existing commands unchanged)
│   │   └── utils/
│   │       ├── logger.ts                    # Existing — add quiet mode support
│   │       ├── error-handler.ts             # NEW: global error handler (user-friendly, DEBUG stack traces)
│   │       └── node-version.ts              # NEW: Node version check helper
│   └── registry/
│       ├── index.ts                         # NEW: public exports
│       ├── registry.ts                      # NEW: loadRegistry, saveRegistry, addCluster, removeCluster
│       ├── find-cluster.ts                  # NEW: findClusterByCwd (longest-prefix-match)
│       ├── schema.ts                        # NEW: Zod schema for clusters.json
│       └── __tests__/
│           ├── registry.test.ts             # NEW: round-trip, atomic write tests
│           └── find-cluster.test.ts         # NEW: prefix-match, subdirectory resolution tests
└── package.json                             # MODIFY: add "engines": {"node": ">=22"}
```

**Structure Decision**: Extends the existing `packages/generacy` package. Placeholder commands are grouped in a single `placeholders.ts` file (one factory function per command is overkill for stubs). Registry logic lives in `src/registry/` as a library module — it will be consumed by future subcommand implementations.

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────┐
│  bin/generacy.js                                     │
│  ┌───────────────┐                                   │
│  │ Node ≥22 gate │─── fail fast with install link    │
│  └───────┬───────┘                                   │
│          ▼                                           │
│  ┌───────────────────────────────────────────────┐   │
│  │  src/cli/index.ts  (Commander.js program)     │   │
│  │                                                │   │
│  │  ┌─────────────┐  ┌───────────────────────┐   │   │
│  │  │  Existing   │  │  Placeholder commands │   │   │
│  │  │  commands   │  │  (launch, up, stop..) │   │   │
│  │  │  (8 cmds)   │  │  (11 stubs)          │   │   │
│  │  └─────────────┘  └───────────────────────┘   │   │
│  │                                                │   │
│  │  ┌──────────────────┐  ┌─────────────────┐    │   │
│  │  │  Error handler   │  │  Logger (pino)  │    │   │
│  │  │  (user-friendly) │  │  (quiet mode)   │    │   │
│  │  └──────────────────┘  └─────────────────┘    │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │  src/registry/                                 │   │
│  │                                                │   │
│  │  loadRegistry() ─► ~/.generacy/clusters.json   │   │
│  │  saveRegistry()    (atomic write via tmp+rename)│   │
│  │  addCluster()                                  │   │
│  │  removeCluster()                               │   │
│  │  findClusterByCwd() (longest-prefix-match)     │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Startup Flow

```
1. bin/generacy.js executes
2. Node version check: parse process.versions.node, compare major ≥ 22
3. If < 22: print error with install link, exit 1
4. Import and call run() from src/cli/index.ts
5. Commander parses args, dispatches to subcommand
6. If placeholder: print phase info message, exit 0
7. If existing command: normal execution
8. On error: global handler prints user-friendly message (stack only if DEBUG=1)
```

### Cluster Registry Flow

```
1. loadRegistry(): read ~/.generacy/clusters.json (create empty if missing)
2. Parse JSON → validate with Zod schema
3. Return typed ClusterRegistry object
4. Mutations: addCluster/removeCluster modify in-memory, then saveRegistry()
5. saveRegistry(): write to .tmp file → fsync → rename (atomic)
6. findClusterByCwd(cwd): filter clusters where cwd starts with cluster.path,
   return the one with the longest path (deepest/most specific match)
```

## Implementation Details

### Node Version Check

```typescript
// src/cli/utils/node-version.ts
export function checkNodeVersion(minimum: number): void {
  const current = parseInt(process.versions.node.split('.')[0]!, 10);
  if (current < minimum) {
    console.error(
      `generacy requires Node.js ${minimum} or later (you have ${process.versions.node}).\n` +
      `Install the latest LTS: https://nodejs.org/en/download`
    );
    process.exit(1);
  }
}
```

### Placeholder Commands

```typescript
// src/cli/commands/placeholders.ts
import { Command } from 'commander';

interface PlaceholderDef {
  name: string;
  description: string;
  phase: string;
}

const PLACEHOLDERS: PlaceholderDef[] = [
  { name: 'launch',      description: 'Launch a new cluster',               phase: 'phase 5' },
  { name: 'up',          description: 'Start a stopped cluster',            phase: 'phase 5' },
  { name: 'stop',        description: 'Stop a running cluster',             phase: 'phase 5' },
  { name: 'down',        description: 'Stop and remove cluster containers', phase: 'phase 5' },
  { name: 'destroy',     description: 'Permanently destroy a cluster',      phase: 'phase 5' },
  { name: 'status',      description: 'Show cluster status',                phase: 'phase 5' },
  { name: 'update',      description: 'Update cluster to latest version',   phase: 'phase 7' },
  { name: 'open',        description: 'Open cluster dashboard in browser',  phase: 'phase 6' },
  { name: 'claude-login',description: 'Authenticate with Claude',           phase: 'phase 6' },
  { name: 'deploy',      description: 'Deploy to production',               phase: 'phase 10' },
  { name: 'rebuild',     description: 'Rebuild cluster from scratch',       phase: 'phase 7' },
];

export function placeholderCommands(): Command[] {
  return PLACEHOLDERS.map(({ name, description, phase }) => {
    const cmd = new Command(name);
    cmd.description(description);
    cmd.allowUnknownOption(true);
    cmd.action(() => {
      console.log(
        `"${name}" is not yet implemented in this preview — ` +
        `landing in a future v1.5 ${phase} issue.`
      );
    });
    return cmd;
  });
}
```

### Global Error Handler

```typescript
// src/cli/utils/error-handler.ts
export function setupErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    console.error(`Error: ${error.message}`);
    if (process.env['DEBUG'] === '1') {
      console.error(error.stack);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Error: ${message}`);
    if (process.env['DEBUG'] === '1' && reason instanceof Error) {
      console.error(reason.stack);
    }
    process.exit(1);
  });
}
```

### Registry Module

```typescript
// src/registry/registry.ts
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClusterRegistrySchema, type ClusterRegistry, type ClusterEntry } from './schema.js';

const REGISTRY_DIR = join(homedir(), '.generacy');
const REGISTRY_PATH = join(REGISTRY_DIR, 'clusters.json');

export async function loadRegistry(): Promise<ClusterRegistry> {
  try {
    const data = await readFile(REGISTRY_PATH, 'utf-8');
    return ClusterRegistrySchema.parse(JSON.parse(data));
  } catch {
    return { version: 1, clusters: [] };
  }
}

export async function saveRegistry(registry: ClusterRegistry): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const tmpPath = REGISTRY_PATH + '.tmp';
  const content = JSON.stringify(registry, null, 2) + '\n';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, REGISTRY_PATH);
}

export async function addCluster(entry: ClusterEntry): Promise<void> {
  const registry = await loadRegistry();
  registry.clusters = registry.clusters.filter(c => c.id !== entry.id);
  registry.clusters.push(entry);
  await saveRegistry(registry);
}

export async function removeCluster(id: string): Promise<void> {
  const registry = await loadRegistry();
  registry.clusters = registry.clusters.filter(c => c.id !== id);
  await saveRegistry(registry);
}
```

### findClusterByCwd

```typescript
// src/registry/find-cluster.ts
import { resolve } from 'node:path';
import { loadRegistry } from './registry.js';
import type { ClusterEntry } from './schema.js';

export async function findClusterByCwd(cwd?: string): Promise<ClusterEntry | undefined> {
  const resolved = resolve(cwd ?? process.cwd());
  const registry = await loadRegistry();

  let best: ClusterEntry | undefined;
  let bestLen = -1;

  for (const cluster of registry.clusters) {
    const clusterPath = resolve(cluster.path);
    if (resolved === clusterPath || resolved.startsWith(clusterPath + '/')) {
      if (clusterPath.length > bestLen) {
        best = cluster;
        bestLen = clusterPath.length;
      }
    }
  }

  return best;
}
```

## Testing Strategy

### Unit Tests

- **Node version check**: mock `process.versions.node`, verify exit on Node 20, pass on Node 22+
- **Placeholder commands**: each prints correct phase message and exits 0
- **Registry round-trip**: save then load preserves all fields
- **Schema validation**: rejects invalid JSON, accepts valid registry
- **findClusterByCwd**: exact match, subdirectory match, deepest-wins, no match returns undefined

### Integration Tests

- **Atomic write**: simulate mid-write crash (write .tmp but don't rename) — original file intact
- **CLI help output**: `generacy --help` lists all placeholder and real subcommands
- **CLI version**: `generacy --version` prints version string

### Test File Locations

```text
packages/generacy/src/
├── cli/
│   ├── __tests__/
│   │   ├── placeholders.test.ts        # Placeholder command output & exit code
│   │   └── node-version.test.ts        # Version gate logic
│   └── utils/
│       └── __tests__/
│           └── error-handler.test.ts   # Global error handler behavior
└── registry/
    └── __tests__/
        ├── registry.test.ts            # Round-trip, atomic write, add/remove
        └── find-cluster.test.ts        # Prefix matching, edge cases
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Single `placeholders.ts` file for all 11 stubs | One file per stub is overkill; data-driven approach keeps it DRY |
| Registry in `src/registry/` not `src/cli/registry/` | Library module reusable by future non-CLI consumers (e.g., orchestrator) |
| Node version check in `bin/generacy.js` | Runs before any ESM import, catches incompatible runtimes early |
| Atomic write via tmp+rename (no fd locking) | Simpler than advisory locks; sufficient for single-user CLI tool |
| Zod schema for clusters.json | Consistent with codebase pattern; validates on load to fail fast on corruption |
| No new npm dependencies | Everything needed is available via existing deps + Node built-ins |
| Existing changeset pipeline for publishing | Per clarification Q1: no `cli-v*` tag workflow; aligns with repo convention |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Placeholder names collide with existing commands | Verified: none of the 11 names overlap with existing 8 commands |
| Registry file corruption | Atomic write; Zod validation on load returns empty registry on parse failure |
| Cross-platform path issues | Use `node:path.resolve()` for normalization; use `/` separator check with platform awareness |
| Node 22 requirement too aggressive | Spec explicitly requires Node 22; error message includes install link |

## Dependencies Resolution

No external feature dependencies. This is a standalone skeleton issue. Future Phase 5 issues (#494–#496) will replace placeholders with real implementations, consuming the registry module shipped here.

---

*Generated by speckit*
