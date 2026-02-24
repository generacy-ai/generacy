# T026 Documentation Index

**Task**: Enable branch protection for agency/main
**Repository**: generacy-ai/agency
**Status**: Ready for execution

---

## 🚦 Start Here

**New to this task?** → [T026-README.md](./T026-README.md)
**Just want to execute?** → [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)
**Need quick reference?** → [T026-SUMMARY.md](./T026-SUMMARY.md)

---

## 📚 Documentation Files

### 🎯 Getting Started

| File | Purpose | Audience | Time |
|------|---------|----------|------|
| [T026-README.md](./T026-README.md) | Comprehensive overview and starting point | Everyone | 5 min read |
| [T026-SUMMARY.md](./T026-SUMMARY.md) | Quick reference card with key information | Quick lookup | 2 min read |
| [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md) | Fast-track execution guide | Execute now | 30 sec read |

### 📖 Detailed Guides

| File | Purpose | Audience | Time |
|------|---------|----------|------|
| [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) | Step-by-step setup (automated + manual) | First-time users | 10 min read |

### 🔧 Executable Scripts

| File | Purpose | Type | Time |
|------|---------|------|------|
| [T026-setup-branch-protection.sh](./T026-setup-branch-protection.sh) | Automated setup via GitHub API | Bash script | 30 sec run |
| [T026-verify-protection.sh](./T026-verify-protection.sh) | Verify configuration is correct | Bash script | 10 sec run |

### 📝 Templates & Completion

| File | Purpose | When to Use |
|------|---------|-------------|
| [T026-COMPLETION-TEMPLATE.md](./T026-COMPLETION-TEMPLATE.md) | Document execution results | After completion |

---

## 🗺️ Navigation Guide

### Scenario 1: First Time Running This Task

1. Start → [T026-README.md](./T026-README.md)
2. Execute → [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)
3. Run → `./T026-setup-branch-protection.sh`
4. Verify → `./T026-verify-protection.sh`
5. Document → Fill out [T026-COMPLETION-TEMPLATE.md](./T026-COMPLETION-TEMPLATE.md)

**Estimated time**: 10-15 minutes

### Scenario 2: Quick Execution (Already Familiar)

1. Execute → [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)
2. Run → `./T026-setup-branch-protection.sh`
3. Verify → `./T026-verify-protection.sh`

**Estimated time**: 2-3 minutes

### Scenario 3: Something Went Wrong

1. Check → [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) → Troubleshooting section
2. Review → Script output for error messages
3. Verify → Prerequisites in [T026-README.md](./T026-README.md)
4. Fallback → Manual setup via GitHub UI (instructions in T026-INSTRUCTIONS.md)

### Scenario 4: Manual Setup Preferred

1. Read → [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) → Option 2: Manual Setup
2. Follow → Step-by-step GitHub UI instructions
3. Verify → Run `./T026-verify-protection.sh`

**Estimated time**: 5-7 minutes

### Scenario 5: Need to Understand Details

1. Overview → [T026-README.md](./T026-README.md)
2. Details → [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md)
3. Reference → [T026-SUMMARY.md](./T026-SUMMARY.md)
4. Code → Review `T026-setup-branch-protection.sh`

**Estimated time**: 20-30 minutes

---

## 📋 Quick Reference

### Repository Information
- **Repo**: [generacy-ai/agency](https://github.com/generacy-ai/agency)
- **Branch**: `main`
- **Settings**: [Branch Protection](https://github.com/generacy-ai/agency/settings/branches)

### Key Commands

```bash
# Setup
./T026-setup-branch-protection.sh

# Verify
./T026-verify-protection.sh

# Check manually
gh api /repos/generacy-ai/agency/branches/main/protection | jq
```

### Required Permissions
- GitHub admin access to generacy-ai/agency
- `gh` CLI authenticated
- `jq` installed

### Dependencies
- **T020**: [DONE] Stable release workflow for agency
- **T012**: [DONE] CI workflow for agency

---

## 🎯 Protection Rules Summary

| Setting | Value |
|---------|-------|
| PR Required | ✅ Yes |
| Approvals | 1 |
| Status Checks | lint, test, build |
| Conversation Resolution | ✅ Required |
| Force Push | ❌ Blocked |
| Branch Deletion | ❌ Blocked |
| Admin Bypass | ✅ Allowed |

---

## 🔗 Related Tasks

| Task | Status | Description |
|------|--------|-------------|
| T012 | [DONE] | Create CI workflow for agency |
| T020 | [DONE] | Create stable release workflow for agency |
| T025 | [DONE] | Enable branch protection for latency/main |
| **T026** | **[Current]** | **Enable branch protection for agency/main** |
| T027 | [Next] | Enable branch protection for generacy/main |
| T038 | [Pending] | Test preview publish for agency |
| T041 | [Pending] | Test stable release for agency |

---

## 📊 File Purpose Matrix

| Need to... | Use this file... |
|------------|------------------|
| Understand the task | [T026-README.md](./T026-README.md) |
| Execute quickly | [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md) |
| Look up settings | [T026-SUMMARY.md](./T026-SUMMARY.md) |
| Follow detailed steps | [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) |
| Run automated setup | [T026-setup-branch-protection.sh](./T026-setup-branch-protection.sh) |
| Verify configuration | [T026-verify-protection.sh](./T026-verify-protection.sh) |
| Document completion | [T026-COMPLETION-TEMPLATE.md](./T026-COMPLETION-TEMPLATE.md) |
| Navigate all docs | [T026-INDEX.md](./T026-INDEX.md) ← You are here |

---

## 💡 Tips

- **First time?** Start with README for context
- **In a hurry?** Jump to EXECUTE-NOW
- **Troubleshooting?** Check INSTRUCTIONS
- **Just checking?** Use SUMMARY
- **Documenting?** Fill out COMPLETION template

---

## ✅ Completion Checklist

- [ ] Read documentation (choose appropriate level)
- [ ] Check prerequisites
- [ ] Run setup script or manual configuration
- [ ] Run verification script
- [ ] Test direct push (should fail)
- [ ] Fill out completion template
- [ ] Mark T026 as [DONE] in tasks.md

---

**Ready?** → [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md) ⚡
