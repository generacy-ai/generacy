# T025: Branch Protection Quick Reference

## One-Page Setup Guide

### URL
```
https://github.com/generacy-ai/latency/settings/branches
```

### Configuration Matrix

| Setting | Value |
|---------|-------|
| **Branch name pattern** | `main` |
| **Require pull request** | ✅ Yes |
| └─ Required approvals | 1 |
| └─ Dismiss stale reviews | ✅ Yes |
| └─ Require Code Owners review | ⬜ No |
| **Require status checks** | ✅ Yes |
| └─ Require up-to-date branches | ✅ Yes |
| └─ Status checks | `lint`, `test`, `build` |
| **Require conversation resolution** | ✅ Yes |
| **Require signed commits** | ⬜ No |
| **Require linear history** | ⬜ No |
| **Include administrators** | ⬜ No (allow bypass) |
| **Allow force pushes** | ❌ No |
| **Allow deletions** | ❌ No |

### Verify Command

```bash
cd /workspaces/generacy/specs/242-1-1-set-up
./T025-verify-protection.sh
```

### Test Command

```bash
# Should fail with "Changes must be made through a pull request"
cd /workspaces/tetrad-development/packages/latency
git checkout main
git commit --allow-empty -m "test: branch protection"
git push origin main
```

### Copy for T026 (agency)

Replace `latency` with `agency`:
```
https://github.com/generacy-ai/agency/settings/branches
```

### Copy for T027 (generacy)

Replace `latency` with `generacy`:
```
https://github.com/generacy-ai/generacy/settings/branches
```

---

## Common Issues

**Q**: Status checks don't appear in dropdown
**A**: Trigger CI workflow first, then refresh settings page

**Q**: Can't access settings
**A**: Need admin permissions on repository

**Q**: Protection not blocking pushes
**A**: Wait 1-2 minutes for settings to propagate

---

**Files**:
- `T025-INSTRUCTIONS.md` - Detailed step-by-step guide
- `T025-verify-protection.sh` - Automated verification script
- `T025-COMPLETION-TEMPLATE.md` - Documentation template
