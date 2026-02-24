# ⚡ T002: Execute Now - npm Token Generation

**Status**: Ready for immediate execution
**Time Required**: 10-15 minutes
**Blocking**: All subsequent tasks (T003-T048)

---

## 🎯 What You're Doing

Generating an npm automation token that GitHub Actions will use to publish @generacy-ai packages.

---

## 📋 Three Simple Steps

### 1️⃣ Generate Token (5 min)
1. Go to: https://www.npmjs.com/login
2. Login → Profile Icon → "Access Tokens"
3. "Generate New Token" → Type: **"Automation"**
4. Permissions: **"Read and Publish"**
5. Description: `GitHub Actions - @generacy-ai publishing`
6. Click "Generate"

### 2️⃣ Save Token (2 min)
1. **COPY THE TOKEN IMMEDIATELY** (you only see it once!)
2. Save to your password manager
3. Label it: "npm @generacy-ai automation token"

### 3️⃣ Document (3 min)
1. Copy: `T002-npm-token-details.template.md` → `T002-npm-token-details.md`
2. Fill in: creation date, your username, token ID (visible on npm tokens page)
3. Save the file

---

## ✅ Completion Checklist

- [ ] Token generated on npmjs.com
- [ ] Token saved to password manager
- [ ] `T002-npm-token-details.md` created and filled out
- [ ] Token type is "Automation" (not "Publish" or "Classic")
- [ ] Token has "Read and Publish" permissions

---

## 🔒 Security Checklist

- [ ] Token NOT committed to git
- [ ] Token NOT shared via chat/email/Slack
- [ ] Token stored ONLY in password manager
- [ ] Token ready for T003 (GitHub Secrets setup)

---

## 📁 Files Created by This Task

After completion, you should have:
- ✅ `T002-npm-token-details.md` (filled template with metadata)
- ✅ Token in password manager
- ✅ Token ready to paste into GitHub (T003)

---

## 🚦 Next Task

After completing T002, proceed to:
**T003**: Configure GitHub organization secret (5 minutes)
- Add the token to GitHub as `NPM_TOKEN`
- This allows workflows to publish packages

---

## 📚 Reference Documents

- **Full Guide**: `T002-npm-token-generation-guide.md`
- **Quick Checklist**: `T002-quick-checklist.md`
- **Template**: `T002-npm-token-details.template.md`

---

## ❓ Need Help?

### Common Issues

**Q: Can't find "Generate New Token" button?**
A: Ensure you're logged in as org admin. Button is at: https://www.npmjs.com/settings/YOUR_USERNAME/tokens

**Q: What if I lose the token before saving?**
A: Delete it on npm and generate a new one. Tokens can only be viewed once.

**Q: Which token type should I use?**
A: "Automation" type. It's designed for CI/CD and doesn't expire.

**Q: What permissions should I select?**
A: "Read and Publish" - this allows publishing packages and reading metadata.

---

**Ready to start? Follow the three steps above! ⬆️**
