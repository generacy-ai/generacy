# T002: npm Token Generation - Quick Checklist

## 🚀 Quick Start (5 minutes)

### Pre-flight
- [ ] T001 complete (org access verified)
- [ ] Password manager ready to store token

### Execute
1. [ ] Go to https://www.npmjs.com/login
2. [ ] Click profile → "Access Tokens"
3. [ ] Click "Generate New Token"
4. [ ] Select type: **"Automation"**
5. [ ] Select permissions: **"Read and Publish"**
6. [ ] (Optional) Description: `GitHub Actions - @generacy-ai publishing`
7. [ ] Click "Generate Token"
8. [ ] **IMMEDIATELY COPY TOKEN** (you only see it once!)
9. [ ] Save token to password manager
10. [ ] Copy `T002-npm-token-details.template.md` → `T002-npm-token-details.md`
11. [ ] Fill in template with creation date, username, token ID

### Verify (Optional)
```bash
# Test token works (replace YOUR_TOKEN)
export NPM_TOKEN='npm_xxxxxxxxxx'
npm whoami --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=$NPM_TOKEN
```

### Complete
- [ ] Token securely stored
- [ ] Token details documented
- [ ] Ready for T003 (add to GitHub secrets)

---

## ⚠️ Security Reminders
- ❌ **NEVER** commit token to git
- ❌ **NEVER** share token via chat/email
- ✅ **ALWAYS** store in password manager
- ✅ **ALWAYS** use "Automation" type for CI/CD

---

## 📋 What You'll Need for T003
After completing this task, you'll need:
- The actual token value (from password manager)
- GitHub organization admin access
- 5 minutes to add secret to GitHub

---

**Estimated Time**: 10-15 minutes
**Next Task**: T003 (Configure GitHub organization secret)
