# Export Inventory: @generacy-ai/contracts

**Date**: 2026-02-24
**Task**: T001 - Generate export inventory
**Repository**: `/workspaces/contracts`

## Executive Summary

- **Total TypeScript Files**: 209
- **Total Exports**: 1,159
- **Average Exports per File**: 5.5

## Directory-Level Export Counts

| Directory | Export Count | Migration Destination | Notes |
|-----------|--------------|----------------------|-------|
| `schemas/` | 797 | `@generacy-ai/agency` | Tool schemas (68.8% of total) |
| `common/` | 77 | `@generacy-ai/latency` | Shared foundation types |
| `agency-humancy/` | 72 | `@generacy-ai/latency` | Cross-component interfaces |
| `agency-generacy/` | 70 | `@generacy-ai/latency` | Cross-component interfaces |
| `orchestration/` | 50 | `@generacy-ai/latency` | Orchestration types |
| `generacy-humancy/` | 42 | `@generacy-ai/latency` | Cross-component interfaces |
| `version-compatibility/` | 23 | `@generacy-ai/latency` | Versioning utilities |
| `telemetry/` | 20 | `@generacy-ai/agency` | Tool telemetry |
| `generated/` | 8 | `@generacy-ai/agency` | Schema generation (calculated) |
| **Total** | **1,159** | | |

## Schemas Subdirectory Breakdown

The `schemas/` directory contains 797 exports across multiple tool domains:

| Schema Domain | Export Count | Purpose |
|---------------|--------------|---------|
| `extension-comms/` | 148 | Extension communication protocols |
| ├─ `extension-comms/workflow/` | 95 | Workflow schemas |
| ├─ `extension-comms/sse/` | 22 | Server-sent events |
| ├─ `extension-comms/coaching/` | 16 | Coaching schemas |
| └─ `extension-comms/decision-queue/` | 12 | Decision queue schemas |
| `knowledge-store/` | 113 | Knowledge management |
| `platform-api/` | 105 | Platform API base |
| ├─ `platform-api/subscription/` | 40 | Subscription management |
| ├─ `platform-api/organization/` | 32 | Organization management |
| └─ `platform-api/auth/` | 30 | Authentication |
| `decision-model/` | 101 | Decision modeling |
| `learning-loop/` | 83 | Learning loop schemas |
| `data-export/` | 82 | Data export utilities |
| `attribution-metrics/` | 74 | Attribution tracking |
| `github-app/` | 44 | GitHub app integration |
| `tool-naming/` | 32 | Tool naming conventions |

## Migration Distribution

### → @generacy-ai/latency (362 exports, 31.2%)

Cross-component types and shared foundation:
- `common/`: 77 exports
- `agency-humancy/`: 72 exports
- `agency-generacy/`: 70 exports
- `orchestration/`: 50 exports
- `generacy-humancy/`: 42 exports
- `version-compatibility/`: 23 exports

These types represent shared abstractions used across multiple components.

### → @generacy-ai/agency (797+ exports, 68.8%)

Tool-specific schemas and telemetry:
- `schemas/`: 797 exports (all subdirectories)
- `telemetry/`: 20 exports
- `generated/`: ~8 exports (estimated)

These types are specific to tool implementations and schema validation.

## Key Observations

1. **Schema-Heavy**: 68.8% of exports are tool schemas destined for agency
2. **Well-Organized**: Clear directory structure maps cleanly to destinations
3. **Balanced Distribution**: Latency gets foundational types, agency gets tool-specific
4. **Test Coverage**: All directories have `__tests__/` subdirectories (not counted)

## Files by Directory

| Directory | File Count | Avg Exports/File |
|-----------|-----------|-----------------|
| `schemas/` | ~150 | 5.3 |
| `common/` | ~15 | 5.1 |
| `agency-humancy/` | ~15 | 4.8 |
| `agency-generacy/` | ~15 | 4.7 |
| `orchestration/` | ~10 | 5.0 |
| Others | ~4 | Variable |

## Next Steps

1. **T002**: Audit high-priority types in latency destination
2. **T003**: Create migration mapping for shared types
3. **T004**: Validate no circular dependencies
4. **T005**: Begin phased migration starting with common/

## Validation Commands

To reproduce these counts:

```bash
# Total exports
cd /workspaces/contracts && rg "^export" src/ --type ts | wc -l

# Total files
cd /workspaces/contracts && find src/ -type f -name "*.ts" | wc -l

# Per-directory counts
cd /workspaces/contracts/src && for dir in */; do
  echo -n "$dir: "
  rg "^export" "$dir" --type ts 2>/dev/null | wc -l
done

# Schemas breakdown
cd /workspaces/contracts/src && find schemas/ -mindepth 1 -type d | while read dir; do
  echo -n "$dir: "
  rg "^export" "$dir" --type ts 2>/dev/null | wc -l
done
```

---

*Generated for task T001 - Export Inventory*
