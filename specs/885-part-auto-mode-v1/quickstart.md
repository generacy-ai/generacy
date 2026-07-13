# Quickstart: `cockpit watch` aggregate events

## Install / build

Nothing new to install. The changes are additive to `@generacy-ai/generacy`:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

## Manual smoke test

Watch an epic and pipe stdout through `jq` to see aggregate events fire:

```bash
generacy cockpit watch generacy-ai/generacy#885 \
  | jq -c 'select(.type == "phase-complete" or .type == "epic-complete")'
```

Startup sweep for pre-completed phases will show `"initial":true`.

## Auto-mode termination edge

Use `--exit-on-epic-complete` to make watch a self-terminating one-shot:

```bash
generacy cockpit watch generacy-ai/generacy#885 --exit-on-epic-complete \
  | while read -r line; do
      case "$(echo "$line" | jq -r .type)" in
        phase-complete)  echo "[phase]  $(echo "$line" | jq -r .phase)" ;;
        epic-complete)   echo "[epic ]  done" ;;
      esac
    done
# exits 0 after epic-complete line is flushed
```

## Available commands

| Command | Purpose |
|---------|---------|
| `generacy cockpit watch <epic-ref>` | Emit per-issue transitions (unchanged) + new aggregate events. |
| `generacy cockpit watch <epic-ref> --exit-on-epic-complete` | Same, but exit 0 after `epic-complete`. |

`<epic-ref>` accepts: bare `<n>` (with resolvable cwd origin), `<owner>/<repo>#<n>`, or full GitHub URL. Contract unchanged from #822/#850.

## Consumer patterns

### Correlate events with epic

`epicRepo` and `epicNumber` are on every aggregate event — no need to thread the CLI arg through consumer state:

```ts
type AggregateEvent = { type: 'phase-complete'; phase: string; epicRepo: string; epicNumber: number; ts: string; initial?: true }
  | { type: 'epic-complete'; epicRepo: string; epicNumber: number; ts: string; initial?: true };

function handleLine(line: string): void {
  const evt = JSON.parse(line);
  if (evt.type === 'phase-complete') queueNextPhase(evt.epicRepo, evt.epicNumber, evt.phase);
  if (evt.type === 'epic-complete') markEpicDone(evt.epicRepo, evt.epicNumber);
}
```

### Dispatch: aggregate vs. per-issue

Aggregate events carry `type`; per-issue events carry `event`. No key collides.

```ts
function isAggregate(o: any): o is AggregateEvent {
  return o?.type === 'phase-complete' || o?.type === 'epic-complete';
}
```

### Idempotence

Startup-sweep events carry `initial: true`. Consumers acting on them should be state-checked anyway (e.g., queueing the next phase should first check whether the queue label already exists). The `initial` flag is a UI hint, not a semantic gate.

## Troubleshooting

**"I see the last `issue-closed` after the `phase-complete` I expected it to trigger."**
Should never happen — ordering is fixed (per-issue → phase-complete → epic-complete). If observed, file a bug with the raw NDJSON stream.

**"Watch exited before I saw all the events I was expecting after `epic-complete`."**
That's the contract — `epic-complete` is the final line under `--exit-on-epic-complete`. Any events that would have followed would have belonged to a later poll cycle that didn't happen.

**"An empty phase heading never fires `phase-complete`."**
That's the contract (Q3 → B). Watch emits one stderr warn at startup for each empty phase; the phase still counts as complete for the whole-epic aggregation.

**"A phase-less epic emits `epic-complete` even though there are no phase headings."**
That's the contract (Q5 → A). The termination edge does not depend on epic body formatting.

**"I see a suggestion string like `epic complete 🎉` on stderr but nothing on the payload."**
That's correct. Presentation prose is the watch plugin's job (agency#386); the engine's contract is machine-pure NDJSON on stdout.

**"After a reopen, I saw `phase-complete` fire twice for the same phase."**
That's the contract — reopen → regress → re-complete fires again. The `ts` values differ.

## Related

- Spec: [spec.md](./spec.md)
- Clarifications: [clarifications.md](./clarifications.md)
- Contract: [contracts/aggregate-events.md](./contracts/aggregate-events.md)
- Plan: [plan.md](./plan.md)
- Research / decisions: [research.md](./research.md)
