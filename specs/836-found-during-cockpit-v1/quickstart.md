# Quickstart — #836

## Reproduce the bug (pre-fix)

Against the current `develop` code, on a machine with `gh` authenticated:

```bash
# From the generacy repo root
pnpm --filter @generacy-ai/generacy build

# Any real epic ref works; a closed reference issue is fine
timeout 75 node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<n> </dev/null
echo "exit: $?"
```

Expected on the buggy build: startup line printed to stderr within seconds, then process exits **0** (not 124) well before the 75 s `timeout` fires — usually within ~1 s of the first poll settling.

## Verify the fix (post-fix)

Same command as above. Expected: startup line prints; process continues running past the 30 s default interval; `timeout` kills it with exit code **124**.

Manual smoke test for SC-004 (end-to-end):

```bash
node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<n>
# In another terminal, add or remove a label on a child issue of that epic.
# The watch process should emit one NDJSON transition line within one interval.
# Ctrl-C should exit 0 within one interval.
```

## Run the regression test

```bash
pnpm --filter @generacy-ai/generacy test -- watch-subprocess
```

Should complete in ~5–10 s. Fails against the pre-fix build, passes against the post-fix build.

## Run all watcher tests

```bash
pnpm --filter @generacy-ai/generacy test -- watch
```

All existing `watch.test.ts` cases still pass (they inject `abortSignal` and don't touch the `sleep()` behavior we're changing).

## Troubleshooting

- **Subprocess test skips locally**: the fixture needs `gh` auth. Set `GH_TOKEN` or run `gh auth login` and re-run.
- **Regression test hangs**: check that the fixture epic ref is a real, resolvable issue — a bad ref causes `resolveEpic` to fail before the startup line prints and the test's "wait for startup line" step times out.
- **`timer.unref` reintroduced by mistake**: the subprocess test will catch this in CI. The inline comment at `watch.ts` line ~55 also flags the constraint for humans; anyone reintroducing `unref` must gate it behind an explicit `WatchDeps` flag the CLI never sets (FR-002).
