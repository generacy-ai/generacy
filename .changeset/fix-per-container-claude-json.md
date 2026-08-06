---
"@generacy-ai/generacy": patch
---

fix(cluster): give every container its own `~/.claude.json` instead of sharing the host's.

Scaffolded clusters bound the operator's live `~/.claude.json` read-write into the orchestrator and every worker. Because that is one file per *host*, not per cluster, every cluster on a machine shared it — and `generacy setup build` writes an absolute, image-flavour-specific agency CLI path into `mcpServers.agency`. Whichever cluster bootstrapped last silently overwrote that entry for all the others, so a source-build cluster could inherit a `/shared-packages/...` path that does not exist in its containers and come up with a dead Agency MCP server.

`claude.json` is now mounted read-only at `/seed/claude.json` and copied to `~/.claude.json` by the container entrypoint on first start (requires the matching cluster-base change; the copy is skipped when no seed is present, so an older image is unaffected). Containers write only to their private copy, which also removes orchestrator-and-N-workers concurrently writing one JSON file.

The seed is a filtered copy rather than the host file itself, so host-specific state never reaches a container:

- **dropped** — `mcpServers` (the flavour-specific paths above, regenerated per container by `setup build`), `projects` (per-directory history keyed by host paths, and most of the file's bulk), `machineID`, and the GrowthBook/experiment caches the CLI refetches anyway.
- **kept** — `oauthAccount`, `userID`, `hasCompletedOnboarding`, `lastOnboardingVersion`, `installMethod`, `autoUpdates`, `theme`.

Auth is unaffected: tokens live in `~/.claude/.credentials.json`, which is already a per-cluster named volume. An existing seed is never overwritten, so a hand-tuned one survives re-scaffolding.
