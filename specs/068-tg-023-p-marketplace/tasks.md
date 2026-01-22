# Tasks: [P] Marketplace Publishing

**Feature**: TG-023 - Marketplace Publishing for VS Code Extension
**Branch**: `068-tg-023-p-marketplace`
**Status**: In Progress

## Tasks

### T001 Configure vsce for packaging
**Files**: `packages/generacy-extension/package.json`, `packages/generacy-extension/.vscodeignore`

- [X] Install @vscode/vsce as dev dependency
- [X] Verify package.json has all required marketplace fields (publisher, repository, etc.)
- [X] Update .vscodeignore to exclude unnecessary files from package
- [X] Test packaging locally with `vsce package`

### T002 Set up CI/CD pipeline for automated publishing
**Files**: `.github/workflows/extension-publish.yml`

- [X] Create GitHub Actions workflow for extension publishing
- [X] Configure secrets for marketplace token (documented in PUBLISHING.md)
- [X] Add version bumping automation (via git tags)
- [X] Test workflow on staging branch (ready for testing when PAT is configured)

### T003 [manual] Test extension in clean VS Code instance
**Files**: Manual testing

- [ ] Install packaged extension in clean VS Code instance
- [ ] Verify all commands work correctly
- [ ] Test authentication flow
- [ ] Verify marketplace metadata displays correctly

### T004 [manual] Publish to VS Code Marketplace
**Files**: Marketplace publishing

- [ ] Create publisher account if needed
- [ ] Review marketplace listing
- [ ] Publish extension (manual trigger or via CI)
- [ ] Verify extension appears in marketplace

---

*Tasks generated for epic child issue*
