---
"@generacy-ai/orchestrator": patch
---

Fix single-package repos failing validate, and surface phase-failure evidence to
the issue (#847).

Two related worker gaps observed when a scaffolded single-package repo hit
`failed:validate`:

- **Default `preValidateCommand` hard-failed single-package repos.** The default
  ran `pnpm install && pnpm -r --filter './packages/*' build`; on a repo with no
  `packages/` directory the filter matched zero projects, pnpm exited 1, and the
  phase died with "Pre-validate install failed" before `validateCommand` ever
  ran. The default now degrades — it runs the `--filter './packages/*' build`
  half only when a `pnpm-workspace.yaml` and at least one `packages/*/package.json`
  are present, so single-package repos install and validate normally without
  needing a per-repo `orchestrator` override.

- **`failed:<phase>` posted no diagnostic to the issue.** A failed phase flipped
  its stage comment to an error state with no command, exit code, or stderr — the
  detail lived only in worker container logs. Failed phases now post a bounded
  failure-evidence block (failing command, exit code, and a stderr tail capped to
  the last 30 lines / 4096 bytes) to the issue so it is visible from GitHub and
  the cockpit.
