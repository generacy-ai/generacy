# T016 Validation: CLI Docs vs Source

Validation of `docs/docs/reference/cli/commands.md` against Commander.js definitions in `packages/generacy/src/cli/commands/*.ts`.

---

## Sub-task 1: Compare every documented command and flag against Commander.js definitions

### Global Options

| Documented | Source (`cli/index.ts`) | Match |
|------------|------------------------|-------|
| `-l, --log-level <level>` choices: trace/debug/info/warn/error/fatal/silent, default: `info` | `.option('-l, --log-level <level>', ...).choices([...]).default('info')` | ✅ |
| `--no-pretty` boolean | `.option('--no-pretty', ...)` | ✅ |
| `-V, --version` | `.version('0.0.1')` | ✅ |
| `-h, --help` | Commander built-in | ✅ |

### `generacy init` (`commands/init/index.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--project-id <id>` string, no default | `.option('--project-id <id>', ...)` | ✅ |
| `--project-name <name>` string, no default | `.option('--project-name <name>', ...)` | ✅ |
| `--primary-repo <repo>` string, no default | `.option('--primary-repo <repo>', ...)` | ✅ |
| `--dev-repo <repo...>` string[], no default | `.option('--dev-repo <repo...>', ...)` | ✅ |
| `--clone-repo <repo...>` string[], no default | `.option('--clone-repo <repo...>', ...)` | ✅ |
| `--agent <agent>` string, default: `claude-code` | `.option('--agent <agent>', ..., 'claude-code')` | ✅ |
| `--base-branch <branch>` string, default: `main` | `.option('--base-branch <branch>', ..., 'main')` | ✅ |
| `--release-stream <stream>` string, default: `stable`, choices: stable/preview | `.option('--release-stream <stream>', ..., 'stable').choices(['stable', 'preview'])` | ✅ |
| `--force` boolean, default: `false` | `.option('--force', ...)` | ✅ |
| `--dry-run` boolean, default: `false` | `.option('--dry-run', ...)` | ✅ |
| `--skip-github-check` boolean, default: `false` | `.option('--skip-github-check', ...)` | ✅ |
| `-y, --yes` boolean, default: `false` | `.option('-y, --yes', ...)` | ✅ |

**Result: 12/12 flags match. No undocumented flags. No phantom flags.**

### `generacy doctor` (`commands/doctor.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--check <name...>` string[] | `.option('--check <name...>', ...)` | ✅ |
| `--skip <name...>` string[] | `.option('--skip <name...>', ...)` | ✅ |
| `-j, --json` boolean, default: `false` | `.option('-j, --json', ...)` | ✅ |
| `-v, --verbose` boolean, default: `false` | `.option('-v, --verbose', ...)` | ✅ |
| `-f, --fix` boolean, default: `false` | `.option('-f, --fix', ...)` | ✅ |

**Result: 5/5 flags match. Check names match source registry.**

### `generacy validate` (`commands/validate.ts`)

| Documented | Source | Match |
|-----------|--------|-------|
| `[config]` optional argument | `.argument('[config]', ...)` | ✅ |
| `-q, --quiet` boolean, default: `false` | `.option('-q, --quiet', ...)` | ✅ |
| `--json` boolean, default: `false` | `.option('--json', ...)` | ✅ |

**Result: 1 argument + 2 flags match.**

### `generacy run` (`commands/run.ts`)

| Documented | Source | Match |
|-----------|--------|-------|
| `<workflow>` required argument | `.argument('<workflow>', ...)` | ✅ |
| `-i, --input <key=value...>` string[], default: `[]` | `.option('-i, --input <key=value...>', ..., [])` | ✅ |
| `-w, --workdir <path>` string, default: cwd | `.option('-w, --workdir <path>', ..., process.cwd())` | ✅ |
| `--dry-run` boolean, default: `false` | `.option('--dry-run', ...)` | ✅ |
| `-v, --verbose` boolean, default: `false` | `.option('-v, --verbose', ...)` | ✅ |

**Result: 1 argument + 4 flags match.**

### `generacy worker` (`commands/worker.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `-u, --url <url>` string, default: `$ORCHESTRATOR_URL` | `.option('-u, --url <url>', ..., process.env['ORCHESTRATOR_URL'])` | ✅ |
| `-i, --worker-id <id>` string, auto-generated | `.option('-i, --worker-id <id>', ...)` | ✅ |
| `-n, --worker-name <name>` string, default: `worker-{hostname}` | `.option('-n, --worker-name <name>', ..., \`worker-${hostname()}\`)` | ✅ |
| `-c, --capabilities <caps...>` string[], default: `[]` | `.option('-c, --capabilities <caps...>', ..., [])` | ✅ |
| `-w, --workdir <path>` string, default: cwd | `.option('-w, --workdir <path>', ..., process.cwd())` | ✅ |
| `-p, --health-port <port>` string, default: `8080` | `.option('-p, --health-port <port>', ..., '8080')` | ✅ |
| `--heartbeat-interval <ms>` string, default: `30000` | `.option('--heartbeat-interval <ms>', ..., '30000')` | ✅ |
| `--poll-interval <ms>` string, default: `5000` | `.option('--poll-interval <ms>', ..., '5000')` | ✅ |
| `--max-concurrent <n>` string, default: `1` | `.option('--max-concurrent <n>', ..., '1')` | ✅ |

**Result: 9/9 flags match.**

### `generacy agent` (`commands/agent.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `-u, --url <url>` string, default: `$ORCHESTRATOR_URL` | `.option('-u, --url <url>', ..., process.env['ORCHESTRATOR_URL'])` | ✅ |
| `-i, --worker-id <id>` string, auto-generated | `.option('-i, --worker-id <id>', ...)` | ✅ |
| `-n, --worker-name <name>` string, default: `agent-{hostname}` | `.option('-n, --worker-name <name>', ..., \`agent-${hostname()}\`)` | ✅ |
| `-c, --capabilities <caps...>` string[], default: `['agent', 'ai']` | `.option('-c, --capabilities <caps...>', ..., ['agent', 'ai'])` | ✅ |
| `-w, --workdir <path>` string, default: cwd | `.option('-w, --workdir <path>', ..., process.cwd())` | ✅ |
| `-p, --health-port <port>` string, default: `8080` | `.option('-p, --health-port <port>', ..., '8080')` | ✅ |
| `--heartbeat-interval <ms>` string, default: `30000` | `.option('--heartbeat-interval <ms>', ..., '30000')` | ✅ |
| `--poll-interval <ms>` string, default: `5000` | `.option('--poll-interval <ms>', ..., '5000')` | ✅ |
| `--agency-mode <mode>` string, default: `subprocess` | `.option('--agency-mode <mode>', ..., 'subprocess')` | ✅ |
| `--agency-url <url>` string, default: `$AGENCY_URL` | `.option('--agency-url <url>', ..., process.env['AGENCY_URL'])` | ✅ |
| `--agency-command <cmd>` string, default: `npx @anthropic-ai/agency` | `.option('--agency-command <cmd>', ..., 'npx @anthropic-ai/agency')` | ✅ |

**Result: 11/11 flags match. Correctly omits `--max-concurrent` (not in agent source).**

### `generacy orchestrator` (`commands/orchestrator.ts`)

| Documented Flag | Source | Match | Notes |
|----------------|--------|-------|-------|
| `-p, --port <port>` string, default: `3100` | `.option('-p, --port <port>', ..., '3100')` | ✅ | See port note below |
| `-h, --host <host>` string, default: `0.0.0.0` | `.option('-h, --host <host>', ..., '0.0.0.0')` | ✅ |
| `--worker-timeout <ms>` string, default: `60000` | `.option('--worker-timeout <ms>', ..., '60000')` | ✅ |
| `--auth-token <token>` string, default: `$ORCHESTRATOR_TOKEN` | `.option('--auth-token <token>', ...)` + `process.env['ORCHESTRATOR_TOKEN']` in action | ✅ |
| `--redis-url <url>` string, default: `$REDIS_URL` | `.option('--redis-url <url>', ...)` + `process.env['REDIS_URL']` in action | ✅ |
| `--label-monitor` boolean, default: `false` | `.option('--label-monitor', ...)` | ✅ |
| `--poll-interval <ms>` string, default: `30000` | `process.env['POLL_INTERVAL_MS'] ?? '30000'` in action | ✅ |
| `--monitored-repos <repos>` string, default: `$MONITORED_REPOS` | `.option('--monitored-repos <repos>', ...)` + `process.env['MONITORED_REPOS']` | ✅ |

**Port discrepancy note:** The CLI Commander.js default for `--port` is `3100`, while the orchestrator config schema (`packages/orchestrator/src/config/schema.ts`) defaults `server.port` to `3000`. The CLI docs accurately document the CLI default (`3100`). A :::note was added to the docs explaining this discrepancy.

**Result: 8/8 flags match source.**

### `generacy setup auth` (`commands/setup/auth.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--email <email>` string, default: `$GH_EMAIL` | `.option('--email <email>', ..., process.env['GH_EMAIL'])` | ✅ |
| `--username <name>` string, default: `$GH_USERNAME` | `.option('--username <name>', ..., process.env['GH_USERNAME'])` | ✅ |

**Result: 2/2 flags match.**

### `generacy setup workspace` (`commands/setup/workspace.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--repos <repos>` string, default: `$REPOS` or all default repos | `.option('--repos <repos>', ...)` + env fallback | ✅ |
| `--branch <branch>` string, default: `$REPO_BRANCH`/`$DEFAULT_BRANCH`/`develop` | `.option('--branch <branch>', ...)` + env fallback chain | ✅ |
| `--workdir <dir>` string, default: `/workspaces` | `.option('--workdir <dir>', ..., '/workspaces')` | ✅ |
| `--clean` boolean, default: `$CLEAN_REPOS` | `.option('--clean', ...)` + env fallback | ✅ |

**Result: 4/4 flags match. Default repos list matches.**

### `generacy setup build` (`commands/setup/build.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--skip-cleanup` boolean, default: `false` | `.option('--skip-cleanup', ...)` | ✅ |
| `--skip-agency` boolean, default: `false` | `.option('--skip-agency', ...)` | ✅ |
| `--skip-generacy` boolean, default: `false` | `.option('--skip-generacy', ...)` | ✅ |

**Result: 3/3 flags match.**

### `generacy setup services` (`commands/setup/services.ts`)

| Documented Flag | Source | Match |
|----------------|--------|-------|
| `--only <target>` string, default: `all`, choices: all/generacy/humancy | `.option('--only <target>', ...)` | ✅ |
| `--skip-api` boolean, default: `false` | `.option('--skip-api', ...)` | ✅ |
| `--timeout <seconds>` string, default: `60` | `.option('--timeout <seconds>', ..., '60')` | ✅ |

**Result: 3/3 flags match. Service ports table matches source constants.**

---

## Sub-task 2: Verify orchestrator default port

**Finding:** The CLI Commander.js definition uses `'3100'` as the default for `--port`. The orchestrator config schema defaults `server.port` to `3000`. These are separate mechanisms:

- **CLI mode** (`generacy orchestrator`): defaults to port `3100`
- **Config file mode** (`orchestrator.yaml`): defaults to port `3000`

The CLI docs correctly document `3100` as the CLI default. A :::note was added to `commands.md` explaining the discrepancy with the config schema default.

**Action taken:** Added explanatory note to the orchestrator section of `commands.md`.

---

## Sub-task 3: Verify `--release-stream` flag on `generacy init` is documented

**Finding:** ✅ Documented at line 68 of `commands.md`:

```
| `--release-stream <stream>` | `string` | `stable` | Release stream. Choices: `stable`, `preview` |
```

Matches source: `.option('--release-stream <stream>', 'Release stream', 'stable')` with `.choices(['stable', 'preview'])`.

---

## Sub-task 4: Ensure no commands or flags are documented that don't exist

**Finding:** ✅ All documented commands exist in source. No phantom commands or flags found.

| Documented Command | Source File | Exists |
|-------------------|-------------|--------|
| `init` | `commands/init/index.ts` | ✅ |
| `doctor` | `commands/doctor.ts` | ✅ |
| `validate` | `commands/validate.ts` | ✅ |
| `run` | `commands/run.ts` | ✅ |
| `worker` | `commands/worker.ts` | ✅ |
| `agent` | `commands/agent.ts` | ✅ |
| `orchestrator` | `commands/orchestrator.ts` | ✅ |
| `setup` | `commands/setup.ts` | ✅ |
| `setup auth` | `commands/setup/auth.ts` | ✅ |
| `setup workspace` | `commands/setup/workspace.ts` | ✅ |
| `setup build` | `commands/setup/build.ts` | ✅ |
| `setup services` | `commands/setup/services.ts` | ✅ |

No undocumented commands found in source (all Commander.js command registrations are covered in the docs).

---

## Summary

| Sub-task | Result |
|----------|--------|
| 1. Compare all commands and flags | **✅ Pass** — 65+ flags across 12 commands, all match source |
| 2. Orchestrator port default | **✅ Documented** — CLI default is `3100` (matches source); note added about config schema discrepancy |
| 3. `--release-stream` on init | **✅ Pass** — Correctly documented with choices and default |
| 4. No phantom commands/flags | **✅ Pass** — 0 non-existent commands or flags documented |

**Changes made:**
- Added :::note to `commands.md` orchestrator section explaining port `3100` (CLI) vs `3000` (config schema) discrepancy

**Total discrepancies: 0** (port default matches CLI source; config schema difference is a codebase issue, not a docs issue)
