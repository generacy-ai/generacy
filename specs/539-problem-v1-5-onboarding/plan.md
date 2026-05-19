# Implementation Plan: Concurrent Local Clusters — Port & Volume Conflicts

**Feature**: Fix hardcoded port bindings and volume names to enable concurrent local clusters
**Branch**: `539-problem-v1-5-onboarding`
**Status**: Complete

## Summary

The scaffolded `docker-compose.yml` hardcodes host port bindings (`3100:3100`, `3101:3101`, `3102:3102`) making it impossible to run multiple Generacy clusters simultaneously. Only port 3100 (orchestrator) actually needs a host binding — ports 3101 (outbound-only relay) and 3102 (Unix-socket control plane) are dead code.

This plan covers:
1. **Scaffolder**: Emit ephemeral port for 3100 (local mode) or fixed `3100:3100` (cloud/deploy mode); remove 3101/3102 entirely
2. **Status command**: Query Docker for live port mappings and display the actual host port
3. **Up command**: Detect legacy hardcoded port format and warn with migration instructions
4. **Tests**: Update existing scaffolder tests, add new tests for port detection and status display

## Technical Context

**Language/Version**: TypeScript, ESM, Node >= 22
**Primary Dependencies**: Commander.js (CLI), Zod (validation), yaml (YAML serialization), Vitest (testing)
**Storage**: Filesystem (`.generacy/` config files, `~/.generacy/clusters.json` registry)
**Testing**: Vitest — unit tests in `__tests__/` co-located with source
**Target Platform**: CLI (`npx generacy` / `generacy` global)
**Project Type**: Monorepo (pnpm workspaces) — this feature touches only `packages/generacy`

## Constitution Check

No constitution file found. No gates to enforce.

## Project Structure

### Documentation (this feature)

```text
specs/539-problem-v1-5-onboarding/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Clarify phase output
├── plan.md              # This file
├── research.md          # Technology research
├── data-model.md        # Data model changes
└── quickstart.md        # Testing & verification guide
```

### Source Code (files to modify)

```text
packages/generacy/src/cli/commands/
├── cluster/
│   ├── scaffolder.ts              # MODIFY: ephemeral port logic, remove 3101/3102
│   └── __tests__/scaffolder.test.ts  # MODIFY: update port assertions, add mode tests
├── status/
│   ├── index.ts                   # MODIFY: extract port mappings from Docker ps output
│   └── formatter.ts               # MODIFY: add port column to table/JSON output
├── up/
│   └── index.ts                   # MODIFY: add legacy port detection + warning
└── launch/
    └── scaffolder.ts              # NO CHANGE: already delegates to cluster/scaffolder
```

## Detailed Design

### 1. Scaffolder Port Changes (`cluster/scaffolder.ts`)

**Current** (line 93):
```ts
ports: ['3100:3100', '3101:3101', '3102:3102'],
```

**New logic**:
```ts
// Local mode: ephemeral host port for 3100 only
// Cloud mode: fixed 3100:3100 for firewall predictability
ports: input.deploymentMode === 'cloud' ? ['3100:3100'] : ['3100'],
```

- `'3100'` (no host part) tells Docker to assign a random host port mapped to container 3100
- 3101 and 3102 are removed entirely (dead code per clarification Q2)
- Deploy scaffolder already passes `deploymentMode: 'cloud'`; launch scaffolder omits it (defaults to `'local'`)

### 2. Status Port Display (`status/index.ts` + `formatter.ts`)

**`docker compose ps --format json`** already returns port data in the `Publishers` field (array of `{URL, TargetPort, PublishedPort, Protocol}`). The current `getClusterServices` function parses `Name`, `State`, `Status` but ignores `Publishers`.

Changes:
- Parse `Publishers` array from Docker ps JSON output
- Find the entry where `TargetPort === 3100` and extract `PublishedPort`
- Add `port` field to `ServiceStatus` → surface as `hostPort` on `ClusterStatus`
- Add "Port" column to table output
- Include `hostPort` in JSON output

### 3. Legacy Port Warning (`up/index.ts`)

Before calling `runCompose`, read the compose file and check for legacy port format:
- Read `docker-compose.yml` via `yaml.parse()`
- Check if `services.cluster.ports` contains any string matching `HOST:CONTAINER` pattern (e.g., `'3100:3100'`)
- If detected, emit a warning via logger:
  ```
  Warning: This cluster uses hardcoded port bindings (e.g., 3100:3100).
  This prevents running multiple clusters simultaneously.
  To fix: delete .generacy/docker-compose.yml and re-run 'generacy launch'.
  ```
- Do NOT block — the cluster still starts normally

### 4. Test Updates

- **`scaffolder.test.ts`**: Update `scaffoldDockerCompose` tests to assert ephemeral port format. Add tests for both local (default) and cloud deployment modes.
- **New test file** `status/__tests__/formatter.test.ts` (if not already present): Test port extraction and display formatting.
- **New test file** `up/__tests__/legacy-port-warning.test.ts`: Test detection logic for legacy hardcoded ports.

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `cluster/scaffolder.ts` | Modify | Ephemeral port for local, fixed for cloud; remove 3101/3102 |
| `cluster/__tests__/scaffolder.test.ts` | Modify | Update port assertions, add deployment mode tests |
| `status/index.ts` | Modify | Parse `Publishers` from Docker ps JSON |
| `status/formatter.ts` | Modify | Add `hostPort` field to schemas, add Port column |
| `up/index.ts` | Modify | Read compose file, detect legacy ports, emit warning |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Docker ps JSON format varies across versions | Low | Medium | Defensive parsing; fallback to `null` port if field missing |
| Existing tests assume hardcoded ports | Certain | Low | Update assertions in same PR |
| Users with existing compose files confused | Medium | Low | Clear warning message with remediation steps |
