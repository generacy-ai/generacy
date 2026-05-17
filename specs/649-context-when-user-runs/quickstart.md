# Quickstart: Launch directory selection prompt

## What Changed

`generacy launch` now shows a multi-option directory picker instead of a yes/no confirmation.

## Usage

### Interactive (no `--dir` flag)

```bash
npx generacy launch --claim=claim_abc123
```

Prompt appears after fetching launch config:

```
? Where should the project be created?
> ~/Generacy/my-project  (default)
  /home/user/code         (current directory)
  Enter a custom path...
```

- Select default → scaffolds into `~/Generacy/<projectName>`
- Select current directory → scaffolds into your shell's cwd
- Select custom → type any path, resolved to absolute

### Scripted / CI (with `--dir`)

```bash
npx generacy launch --claim=claim_abc123 --dir=/opt/projects/myapp
```

No prompt shown. Scaffolds directly into `/opt/projects/myapp`.

## Edge Cases

- If cwd is the same as the default path, the "current directory" option is hidden (no duplicate)
- If cwd already contains `.generacy/`, the option label shows a warning hint
- Pressing Ctrl+C at any prompt exits with code 130

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Directory already contains .generacy/" error | Choose a different directory or remove the existing `.generacy/` folder |
| Prompt not appearing | Ensure you're not passing `--dir`; check terminal supports interactive input |
| Custom path not found | The scaffolder creates the directory — just ensure the parent exists and is writable |
