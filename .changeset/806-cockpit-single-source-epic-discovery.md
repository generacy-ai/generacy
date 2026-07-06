---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Single-source epic discovery from the epic issue body (#806).

Replaces the two-tier manifest + label-search discovery with one mechanism: a
resolver in `@generacy-ai/cockpit` (`resolveEpic`) that parses the epic issue
body — `owner/repo#N` task-list refs (`- [ ]` / `- [x]`) grouped under
`### <phase>` headings, plus markdown-linked and plain-URL variants — and fails
loud with the expected format when nothing parses. Refs are re-resolved every
poll tick so children added mid-epic join automatically.

On the CLI side (`@generacy-ai/generacy`), `generacy cockpit watch`/`status`
scope by `--epic` only (the `--repos` flag is dropped; the repo set derives from
the resolved refs), and `generacy cockpit queue <epic-ref> <phase>` reads its
membership from the matching phase heading (`--label` overrides the default
`process:speckit-feature`). Removes the manifest read path and label-search
fallback (`resolveEpicIssues`), the `manifest init`/`sync` verbs and
`manifest/**` subcommand files, `repos` from the cockpit config schema, and the
`MONITORED_REPOS` coupling.

Because the cockpit no longer configures a monitored-repo list, the
`cockpit advance` / `state` / `clarify-context` commands no longer accept a
bare issue number (it was resolved against the configured repo); pass a
repo-qualified `<owner>/<repo>#<n>` ref or a full issue/PR URL instead.
