# @generacy-ai/generacy

Headless CLI for running Generacy workflows in containers and CI/CD environments.

## Installation

```bash
npm install -g @generacy-ai/generacy
```

Or use with npx:

```bash
npx @generacy-ai/generacy run workflow.yaml
```

## Features

- **Headless Execution**: Run workflows without VS Code or GUI
- **Orchestrator Integration**: Connect to Generacy orchestrator for job management
- **Worker Mode**: Process jobs from a central queue
- **Agent Mode**: Enhanced worker with AI tool routing via Agency
- **Health Checks**: Built-in health endpoints for container orchestration
- **Configurable**: Environment variables and CLI options

## CLI Commands

### Run a Workflow

Execute a workflow file directly:

```bash
generacy run workflow.yaml

# With inputs
generacy run workflow.yaml -i name=value -i count=5

# In a specific directory
generacy run workflow.yaml -w /path/to/project

# Dry run (validation only)
generacy run workflow.yaml --dry-run

# Execute single step
generacy run workflow.yaml --single-step "step-name"
```

### Worker Mode

Start a worker that processes jobs from the orchestrator:

```bash
generacy worker --url http://orchestrator:3000

# With custom worker ID
generacy worker -u http://orchestrator:3000 -i my-worker-01

# With capabilities
generacy worker -u http://orchestrator:3000 -c nodejs -c typescript

# Custom health port
generacy worker -u http://orchestrator:3000 -p 9090
```

### Agent Mode

Start an agent worker with AI tool routing:

```bash
generacy agent --url http://orchestrator:3000

# With network Agency
generacy agent -u http://orchestrator:3000 --agency-mode network --agency-url http://agency:8000

# With subprocess Agency
generacy agent -u http://orchestrator:3000 --agency-mode subprocess --agency-command "npx agency"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level | `info` |
| `GENERACY_PRETTY_LOG` | Enable pretty logging | `true` (dev) |
| `GENERACY_WORKDIR` | Working directory | `process.cwd()` |
| `ORCHESTRATOR_URL` | Orchestrator service URL | - |
| `ORCHESTRATOR_TOKEN` | Authentication token | - |
| `WORKER_ID` | Worker identifier | auto-generated |
| `HEALTH_PORT` | Health check port | `8080` |
| `HEARTBEAT_INTERVAL` | Heartbeat interval (ms) | `30000` |
| `POLL_INTERVAL` | Job poll interval (ms) | `5000` |
| `AGENCY_MODE` | Agency mode | `subprocess` |
| `AGENCY_URL` | Agency URL (network mode) | - |
| `AGENCY_COMMAND` | Agency command (subprocess) | `npx @anthropic-ai/agency` |

### CLI Options

Global options available for all commands:

```bash
-l, --log-level <level>  Log level (trace, debug, info, warn, error)
--no-pretty              Disable pretty logging (use JSON)
```

## Docker Usage

```dockerfile
FROM node:20-alpine

RUN npm install -g @generacy-ai/generacy

WORKDIR /app

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:8080/health || exit 1

# Run as worker
CMD ["generacy", "worker", "-u", "http://orchestrator:3000"]
```

Docker Compose example:

```yaml
services:
  worker:
    image: generacy-worker
    environment:
      - ORCHESTRATOR_URL=http://orchestrator:3000
      - ORCHESTRATOR_TOKEN=${ORCHESTRATOR_TOKEN}
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 3s
      retries: 3
```

## Health Endpoints

The worker exposes health endpoints on the configured port:

- `GET /health` - Full health status
- `GET /ready` - Readiness probe
- `GET /live` - Liveness probe

Example response:

```json
{
  "status": "healthy",
  "uptime": 3600000,
  "lastHeartbeat": "2024-01-15T10:30:00.000Z",
  "currentJob": null,
  "timestamp": "2024-01-15T10:30:30.000Z"
}
```

## Programmatic Usage

Use as a library in your Node.js applications:

```typescript
import {
  OrchestratorClient,
  createAgencyConnection,
  loadWorkflow,
  WorkflowExecutor,
} from '@generacy-ai/generacy';

// Create orchestrator client
const client = new OrchestratorClient({
  baseUrl: 'http://orchestrator:3000',
});

// Register worker
await client.register({
  id: 'my-worker',
  name: 'My Worker',
  capabilities: ['nodejs'],
  maxConcurrent: 1,
});

// Poll for jobs
const response = await client.pollForJob('my-worker');
if (response.job) {
  // Execute the job workflow
  const workflow = await loadWorkflow(response.job.workflow);
  // ...
}
```

## Graceful Shutdown

The worker handles SIGTERM and SIGINT for graceful shutdown:

1. Stops accepting new jobs
2. Waits for current job to complete (up to 60 seconds)
3. Sends final heartbeat
4. Unregisters from orchestrator
5. Closes health server

## `cockpit watch` — stream grammar

`generacy cockpit watch <epic-ref>` streams one NDJSON event per line to stdout. Every emitted line is a JSON object with a `type` field equal to exactly one of the three values below. Consumers dispatching on `type` see 100% of the stream.

| `type`             | Fields                                                                                              | Emitted when |
|--------------------|-----------------------------------------------------------------------------------------------------|--------------|
| `issue-transition` | `type`, `ts`, `repo`, `kind`, `number`, `from`, `to`, `sourceLabel`, `url`, `event`, `labels`, `initial?` | Per-issue or per-PR state transition surfaced by the poll loop's diff step. |
| `phase-complete`   | `type`, `phase`, `epicRepo`, `epicNumber`, `ts`, `initial?`                                          | Every ref in a phase is CLOSED (fires once per transition into fully-closed). |
| `epic-complete`    | `type`, `epicRepo`, `epicNumber`, `ts`, `initial?`                                                   | Every ref in the epic is CLOSED. |

`initial: true` (optional, all three types) marks lines emitted during the startup sweep — see [Startup sweep](#startup-sweep).

### `issue-transition`

```json
{"type":"issue-transition","ts":"2026-07-09T14:20:03.111Z","repo":"o/r","kind":"issue","number":123,"from":"pending","to":"active","sourceLabel":"phase:plan","url":"https://github.com/o/r/issues/123","event":"label-change","labels":["phase:plan"]}
```

- `event` — the reason for the transition: `label-change`, `issue-closed`, `pr-merged`, `pr-closed`, or `pr-checks`.
- `from` / `to` — cockpit-state values; `null` on the initial sweep (`from`) or on a terminal close (`to`).
- `sourceLabel` — the label that determined `to`, or `null`.
- `kind` — `issue` for GitHub issues; `pr` for pull requests (`pr-*` events).
- Legacy consumers dispatching on `event` are unchanged; the `event` field is retained with the same enum values and semantics.

### `phase-complete`

Fires once per transition into a fully-closed phase (last open issue in the phase closes; `not_planned` closures count as done).

```json
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:23:11.041Z"}
```

- `phase` — the phase heading text, verbatim.
- After a reopen that regresses the phase, re-completion fires the event again.
- Empty phase (heading with `refs.length === 0`) never fires `phase-complete`. One stderr warning is emitted at watch startup instead: `cockpit watch: phase "<heading>" has no issue refs; treated as complete`.
- Issues in the `(no phase)` bucket are excluded from `phase-complete`.
- Phase-less epic (no phase headings) never fires `phase-complete`.

### `epic-complete`

Fires once when every ref in the epic is CLOSED, regardless of phase structure. Empty phases contribute nothing to the ref set, so they don't block the epic edge.

```json
{"type":"epic-complete","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:25:03.782Z"}
```

### Startup sweep

If per-issue state, a fully-closed phase, or a fully-closed epic is already the truth at watch start, the corresponding events fire immediately with `"initial": true` so consumers can distinguish "this just happened" from "this was already true when I attached":

```json
{"type":"issue-transition","ts":"…","repo":"o/r","kind":"issue","number":123,"from":null,"to":"active","sourceLabel":"phase:plan","url":"…","event":"label-change","labels":["phase:plan"],"initial":true}
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"o/r","epicNumber":1,"ts":"…","initial":true}
{"type":"epic-complete","epicRepo":"o/r","epicNumber":1,"ts":"…","initial":true}
```

Per-issue startup-sweep semantics were introduced in #839; aggregate startup-sweep semantics in #885. Both are covered by the single shape above: `initial: true` on the first appearance.

### `--exit-on-epic-complete`

Boolean flag (default false). When set, watch drains stdout and exits `0` after emitting the `epic-complete` line. That line is guaranteed to be the final line ever written. Consumers on `stdin` see clean EOF after it.

```bash
generacy cockpit watch owner/repo#123 --exit-on-epic-complete | jq -c .
```

### Ordering within a poll cycle

When a single poll produces multiple events, ordering is deterministic:

1. All `issue-transition` events in existing order.
2. All `phase-complete` events in body order.
3. `epic-complete` last if firing.

This guarantees cause precedes effect (the last `issue-closed` is always visible before the `phase-complete` it triggered) and — with `--exit-on-epic-complete` — that `epic-complete` is the final line on stdout before the process exits.

### Payload discipline

`phase-complete` and `epic-complete` carry `epicRepo` and `epicNumber` for correlation. They do **not** carry `closedRefs`, `totalCount`, `suggestion`, or any per-issue field (`repo`, `kind`, `number`, `url`, `labels`, `sourceLabel`, `from`, `to`, `event`). Human-readable prose (celebration lines, next-step suggestions) is the watch plugin's responsibility, derived from the payload — not the engine's.

### Programmatic parsing

```ts
import { CockpitStreamEventSchema } from '@generacy-ai/generacy';

for await (const line of readLines(childStdout)) {
  const evt = CockpitStreamEventSchema.parse(JSON.parse(line));
  // switch on evt.type — full type narrowing available
}
```

## `cockpit resume` — re-arm a failed phase

`generacy cockpit resume <issue>` is the engine-owned re-arm operation for a failed phase. On an issue carrying `failed:<phase>`, it applies the same label triple a naturally-paused-then-completed gate would have — the label monitor's next poll enqueues the issue, and the worker's phase resolver walks the preserved `completed:<earlier-phase>` chain to pick `<phase>` as the start phase. Failed-issue recovery becomes a one-liner instead of by-hand label surgery.

### Accepted ref forms

Same as every other cockpit verb (see [#822/#850](https://github.com/generacy-ai/generacy/pull/850) unified issue-ref grammar):

- bare number: `42` — requires a resolvable GitHub `origin` in cwd
- `owner/repo#N`: `generacy-ai/generacy#42`
- full URL: `https://github.com/generacy-ai/generacy/issues/42`

### Options

| Flag | Description |
|---|---|
| `--workflow <name>` | Workflow-name override. Defaults to the issue's `workflow:<name>` label, or `speckit-feature` if absent. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Happy path (labels mutated) OR no-op (nothing to re-arm). |
| `1` | Remote/transport failure — `gh` API call error mid-sequence. |
| `2` | Argument error — missing `<issue>`, malformed ref, unresolvable bare number. |
| `3` | Refusal — ambiguous or non-re-armable state. Stderr names the offending labels. |

### Labels added / removed (happy path)

**Added** (single API call, in order):
- `waiting-for:<preceding-gate>`
- `completed:<preceding-gate>`
- `agent:paused`

**Removed** (single API call, defensive):
- `failed:<phase>` — always
- `agent:error` — only if present
- `phase:<phase>` — only if present

`<preceding-gate>` is derived (not hardcoded) by inverting `GATE_MAPPING` from the orchestrator. For `speckit-feature` today: `failed:validate → implementation-review`, `failed:implement → tasks-review`, `failed:tasks → plan-review`, `failed:clarify → spec-review`. `failed:specify` and `failed:plan` have no preceding gate and fall to the refusal path.

### Idempotency

- No-op on non-failed issues: single-line stdout, zero mutations, exit 0.
- Running `resume` twice on the same issue is safe — the second call either takes the no-op branch (if the failed set is already gone) or repeats the additions (GitHub's label add is idempotent).

### Refusal semantics (all exit 3, zero mutations)

| Branch | Trigger |
|---|---|
| Multiple failed labels | Fetched set contains ≥2 `failed:*` labels. |
| Unknown phase | `failed:<phase>` where `<phase>` is not a workflow phase. |
| No preceding gate | `<phase>` has no gate in the effective gate mapping — evidence points at `process:<workflow>` re-queue. |
| Conflicting waiting | Existing `waiting-for:<other>` ≠ derived `<preceding-gate>`. |

### Example

```bash
$ generacy cockpit resume generacy-ai/generacy#42
resumed generacy-ai/generacy#42: re-armed phase=validate via preceding-gate=implementation-review; added=[waiting-for:implementation-review,completed:implementation-review,agent:paused] removed=[failed:validate,agent:error,phase:validate]
```

## License

MIT
