# Research: Launch directory selection prompt

## Technology Decisions

### `@clack/prompts` `p.select()` — confirmed available

The codebase already uses `@clack/prompts` extensively (`p.confirm()`, `p.text()`, `p.spinner()`, `p.select()` in other commands like `destroy`). No new dependency needed.

`p.select()` API:
```typescript
const value = await p.select({
  message: 'Where should the project be created?',
  options: [
    { value: '/home/user/Generacy/my-project', label: '~/Generacy/my-project (default)' },
    { value: '/home/user/code', label: '/home/user/code (current directory)' },
    { value: '__custom__', label: 'Enter a custom path...' },
  ],
});
```

Returns the `value` field of the selected option, or a cancel symbol detectable via `p.isCancel()`.

### Path resolution approach

- Use `path.resolve()` for custom paths (handles both relative and absolute input)
- Use `os.homedir()` for tilde display in labels (display `~/Generacy/...` but return full path)
- `existsSync()` to detect `.generacy/` presence for warning labels

### Alternatives considered

| Option | Decision | Rationale |
|--------|----------|-----------|
| Add `--here` flag | Rejected | Spec explicitly says no new CLI flags |
| Fuzzy path autocomplete | Rejected | Over-engineering; `p.text()` sufficient for custom path |
| Directory browser (file picker) | Rejected | Not available in terminal; `p.text()` is the standard pattern |

## Implementation Patterns

### Prompt composition pattern (from `destroy` command)

```typescript
// Pattern: select → conditional follow-up → cancel guard
const selection = await p.select({ ... });
exitIfCancelled(selection);

if (selection === '__custom__') {
  const customPath = await p.text({ ... });
  exitIfCancelled(customPath);
  return resolve(customPath as string);
}
return selection as string;
```

### Label formatting

Display shortened paths using tilde notation for readability:
```typescript
function formatPath(absPath: string): string {
  const home = homedir();
  if (absPath.startsWith(home)) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}
```

## Key References

- `packages/generacy/src/cli/commands/launch/prompts.ts` — current `confirmDirectory`
- `packages/generacy/src/cli/commands/launch/index.ts:125-132` — current caller
- `packages/generacy/src/cli/commands/destroy/index.ts` — example of `p.select()` + `p.confirm()` usage in the CLI
- `@clack/prompts` docs: select, text, isCancel APIs
