# T004 Research: Internal Links to Reference Pages Being Rewritten

## Summary

Searched all files under `docs/` for links pointing to reference pages being rewritten or created as part of this spec. Found **5 links across 3 files** that will need attention after rewrites, plus the sidebar configuration which needs new entries for the 3 new pages.

---

## Links Found

### 1. `/docs/reference/config/agency` (being rewritten → placeholder)

| File | Line | Context | Action Needed |
|------|------|---------|---------------|
| `docs/docusaurus.config.ts` | 102 | `to: '/docs/reference/config/agency'` — footer "Configuration" link | **Review**: Link still valid after rewrite (page exists, just content changes). Consider whether footer should point to `agency.md` or a better landing page like `generacy.md` after rewrite. |
| `docs/docs/reference/api/index.md` | 309 | `[Configuration Reference](/docs/reference/config/agency)` — "Next Steps" section | **Update**: Link text says "Configuration Reference" but points to agency config specifically. After rewrite, agency.md becomes a placeholder — this should point to `generacy.md` or the config category index instead. |
| `docs/sidebars.ts` | 89 | `'reference/config/agency'` — sidebar entry | **No change**: Page still exists after rewrite. |

### 2. `/docs/reference/cli/commands` (being rewritten)

| File | Line | Context | Action Needed |
|------|------|---------|---------------|
| `docs/docs/reference/api/index.md` | 310 | `[CLI Commands](/docs/reference/cli/commands)` — "Next Steps" section | **No change**: Link still valid after rewrite (page exists, just content changes). |
| `docs/sidebars.ts` | 98 | `'reference/cli/commands'` — sidebar entry | **No change**: Page still exists after rewrite. |

### 3. `/docs/reference/config/generacy` (being rewritten)

| File | Line | Context | Action Needed |
|------|------|---------|---------------|
| `docs/sidebars.ts` | 91 | `'reference/config/generacy'` — sidebar entry | **No change**: Page still exists after rewrite. |

### 4. New pages (no existing links — sidebar needs updating)

The following new pages are being created and have **no existing links** pointing to them (expected — they don't exist yet):

- `/docs/reference/config/orchestrator` (new)
- `/docs/reference/config/environment-variables` (new)
- `/docs/reference/config/docker-compose` (new)

These need to be added to:

| File | Line | Context | Action Needed |
|------|------|---------|---------------|
| `docs/sidebars.ts` | 88-92 | Configuration category items | **Add**: `'reference/config/orchestrator'`, `'reference/config/environment-variables'`, `'reference/config/docker-compose'` |

---

## Action Items for T012 (Cross-References & Link Fixes)

### Must Fix
1. **`docs/docs/reference/api/index.md:309`** — Change `[Configuration Reference](/docs/reference/config/agency)` to point to a better target (e.g., `/docs/reference/config/generacy` or the config category index), since agency.md will become a placeholder.

### Must Add
2. **`docs/sidebars.ts`** — Add 3 new pages to the Configuration category:
   - `'reference/config/orchestrator'`
   - `'reference/config/environment-variables'`
   - `'reference/config/docker-compose'`

### Should Review
3. **`docs/docusaurus.config.ts:102`** — Footer "Configuration" link currently points to `/docs/reference/config/agency`. After agency.md becomes a placeholder, consider updating to `/docs/reference/config/generacy` or the config category index.

### No Change Needed
4. `docs/docs/reference/api/index.md:310` — CLI Commands link remains valid.
5. `docs/sidebars.ts:89-91,98` — Existing sidebar entries remain valid (pages still exist after rewrite).

---

## Other Observations

- No links to reference pages were found in guide pages (`docs/docs/guides/**`), getting-started pages, or architecture pages (they link to guide-level config pages like `/docs/guides/agency/configuration`, not reference pages).
- The `/docs/reference/config/humancy` page is listed in sidebars (line 90) and is **not** being modified (out of scope per plan).
- No relative links (`../reference/...`) were found — all cross-references use absolute `/docs/reference/...` format.
