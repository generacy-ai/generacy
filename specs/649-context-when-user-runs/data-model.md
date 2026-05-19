# Data Model: Launch directory selection prompt

## Core Types

### `SelectDirectoryOption` (internal to prompts.ts)

Used to build the `p.select()` options array dynamically:

```typescript
interface SelectDirectoryOption {
  value: string;       // Absolute path or '__custom__' sentinel
  label: string;       // Display string (e.g., "~/Generacy/my-project (default)")
  hint?: string;       // Optional annotation (e.g., "already contains .generacy/")
}
```

### Function Signatures

```typescript
// New — replaces confirmDirectory
export async function selectDirectory(
  defaultDir: string,  // Resolved absolute default path (~/Generacy/<name>)
  cwd: string,         // process.cwd() resolved
): Promise<string>;    // Returns chosen absolute path

// Removed
// export async function confirmDirectory(dir: string): Promise<boolean>;
```

### Sentinel Value

```typescript
const CUSTOM_PATH_SENTINEL = '__custom__';
```

Used as the `value` for the "Enter a custom path..." option. When selected, triggers a follow-up `p.text()` prompt.

## Validation Rules

| Field | Rule | Error Message |
|-------|------|---------------|
| Custom path input | Non-empty after trim | "Path cannot be empty" |
| Custom path input | No whitespace-only | "Path cannot be empty" |

Path resolution (not validation — the scaffolder handles existence checks):
- Relative paths resolved via `path.resolve(cwd, input)`
- Absolute paths used as-is

## Relationships

```
index.ts (caller)
  └── opts.dir provided? → resolveProjectDir() → skip prompt
  └── opts.dir missing?  → selectDirectory(defaultDir, cwd) → returns absolute path
                              └── p.select() → defaultDir | cwd | CUSTOM_PATH_SENTINEL
                              └── if CUSTOM_PATH_SENTINEL → p.text() → resolve()
```

No new types are exported from the package. No schema changes. No persistence changes.
