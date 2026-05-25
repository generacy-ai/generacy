---
"@generacy-ai/workflow-engine": patch
---

Follow-up to the bulk worker-scale catch-up (#719). The orchestrator was bumped
to 0.2.0 in that batch with `^0.1.1` pinning on `@generacy-ai/workflow-engine`,
but workflow-engine itself wasn't bumped — leaving stable on 0.1.1 from May 20.
The orchestrator's published 0.2.0 imports `FilesystemWorkflowStore` (added to
`workflow-engine/src/index.ts`'s top-level re-exports in a later develop commit),
so loading `@generacy-ai/orchestrator@0.2.0` against `workflow-engine@0.1.1`
fails with:

    Failed to load @generacy-ai/orchestrator: The requested module
    '@generacy-ai/workflow-engine' does not provide an export named
    'FilesystemWorkflowStore'

Patch bump (rather than minor) so the orchestrator's existing `^0.1.1` semver
range picks up `0.1.2` automatically — no orchestrator re-publish needed.

The broader process gap (per-PR changesets not enforced) is tracked in #720.
