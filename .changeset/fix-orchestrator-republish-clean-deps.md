---
"@generacy-ai/orchestrator": patch
---

Force a republish of `@generacy-ai/orchestrator` after the release workflow was fixed to actually rewrite `workspace:` dependencies. The previous publish (0.1.2) shipped with `workspace:^` literals in `dependencies` because `pnpm changeset publish` internally shells out to `npm publish`, which doesn't understand the workspace protocol. The fixed workflow uses `pnpm -r publish` (matching what `publish-preview.yml` already does) so the rewrite happens at pack time. This release retires the broken 0.1.2.
