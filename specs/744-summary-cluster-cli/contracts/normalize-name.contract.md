# Contract: `normalizeClusterName` & `sanitizeProjectComponent`

Both helpers live in `packages/generacy/src/cli/commands/cluster/name-normalize.ts`.

## `normalizeClusterName(input: string): string | null`

Normalizes a user-supplied `--name` value into a safe slug.

**Steps**:
1. Lowercase the input.
2. Replace any run of characters not in `[a-z0-9-]` with a single `-`.
3. Trim leading and trailing `-`.
4. Truncate to 63 chars.
5. If the result is empty, return `null` (caller rejects).
6. If the first char is not a letter, prepend `c-`, then re-truncate to 63 chars.
7. Return the result.

**Post-condition**: returned string matches `/^[a-z][a-z0-9-]{0,62}$/`.

**Examples**:

| Input | Output |
|---|---|
| `"ACME Frontend"` | `"acme-frontend"` |
| `"  weird___name!!!  "` | `"weird-name"` |
| `"123-numeric-start"` | `"c-123-numeric-start"` |
| `"日本語"` | `"c-"`? → empty after collapse → `null` ⚠️ |
| `""` | `null` |
| `"!!"` | `null` (everything collapses to `-`, trim leaves empty) |
| `"a" * 100` | `"aaa...a"` (truncated to 63) |

## `sanitizeProjectComponent(projectName: string): string`

Same algorithm as `normalizeClusterName` but with `maxLen=40` and a fallback so the function never returns empty.

**Steps**: identical to steps 1–6 of `normalizeClusterName`, but:
- truncate to 40 instead of 63 (steps 4 and 6),
- if step 5 would return null, return the string `"cluster"` instead.

**Post-condition**: returned string matches `/^[a-z][a-z0-9-]{0,39}$/`.

**Examples**:

| Input | Output |
|---|---|
| `"ACME Frontend"` | `"acme-frontend"` |
| `"@scope/pkg-name"` | `"scope-pkg-name"` |
| `""` | `"cluster"` |
| `"日本語"` | `"cluster"` |
| `"very-long-project-name-exceeding-forty-chars-limit"` | `"very-long-project-name-exceeding-forty-c"` (40 chars) |

## `generateDefaultName(projectId, projectName, registry): string`

Located in `packages/generacy/src/cli/commands/cluster/default-name.ts`.

**Inputs**:
- `projectId: string` — from `LaunchConfig.projectId`.
- `projectName: string` — from `LaunchConfig.projectName`.
- `registry: Registry` — current contents of `~/.generacy/clusters.json`.

**Algorithm**:
1. `project = sanitizeProjectComponent(projectName)` (always non-empty).
2. `taken = Set of displayName values from registry entries where projectId matches AND (deploymentMode ?? 'local') === 'local'`.
3. For `n = 1, 2, 3, ...`, return `${project}-local-${n}` if not in `taken`.

**Notes**:
- Old registry entries lacking `projectId` are excluded from the set (they don't participate in sequencing).
- Old entries lacking `deploymentMode` are treated as `'local'`.
- Concurrent CLI invocations are not locked; two parallel launches may pick the same `n`. Accept this rare collision; it's user-recoverable.
