# T010 Quick Guide: Update Generacy Repo README

**Task Type**: Documentation
**Effort**: 15 minutes
**Prerequisites**: T009 (Publishing documentation must exist)

## Objective

Update the Generacy repository README.md to include a link to the VS Code Marketplace publisher setup documentation.

## Steps

### 1. Check Current README Status

```bash
cat /workspaces/generacy/README.md
```

**Decision Point**:
- If publishing section exists → Add link to existing section
- If README is minimal/empty → Create comprehensive README with publishing section
- If README is complete without publishing → Add new publishing section

### 2. Create or Update Publishing Section

Add the following section to README.md:

```markdown
## Publishing

### VS Code Extensions

This repository includes VS Code extension development and publishing infrastructure.

**Publisher Details**:
- Publisher ID: `generacy-ai`
- Marketplace: [https://marketplace.visualstudio.com/publishers/generacy-ai](https://marketplace.visualstudio.com/publishers/generacy-ai)

**Documentation**:
- [VS Code Marketplace Setup Guide](/docs/publishing/vscode-marketplace-setup.md) - Complete guide for publisher account, PAT management, and CI/CD publishing
```

### 3. Update Documentation Links Section

If a "Documentation" section exists, add:

```markdown
- **Publishing Guide**: [/docs/publishing/vscode-marketplace-setup.md](/docs/publishing/vscode-marketplace-setup.md)
```

### 4. Verify Links

Check that the link path is correct:

```bash
ls -la /workspaces/generacy/docs/publishing/vscode-marketplace-setup.md
```

Should show the file exists.

## Quality Checklist

- [ ] Publishing section is clearly visible in README
- [ ] Link to `/docs/publishing/vscode-marketplace-setup.md` is correct
- [ ] Link uses relative path (starts with `/docs/`, not absolute path)
- [ ] Publisher ID `generacy-ai` is mentioned
- [ ] Marketplace profile URL is included
- [ ] Markdown formatting is correct
- [ ] README renders properly on GitHub

## Common Issues

### Issue: README is completely empty

**Solution**: Create a full README from scratch including:
- Project overview and description
- Quick start guide
- Development commands
- Project structure
- Publishing section (with required link)
- Documentation links
- License and contact info

### Issue: Link path is incorrect

**Correct**: `/docs/publishing/vscode-marketplace-setup.md`
**Incorrect**:
- `docs/publishing/vscode-marketplace-setup.md` (missing leading slash)
- `/workspaces/generacy/docs/publishing/...` (absolute path)
- `./docs/publishing/...` (relative to current location)

### Issue: Publishing section is too prominent

**Note**: This is intentional. The publishing documentation is important for:
- Issue 1.6 (Agency extension CI/CD)
- Issue 1.7 (Generacy extension CI/CD)
- Future extension development

It should be easily discoverable.

## Verification

### Manual Check

1. View README.md in GitHub (or local markdown viewer)
2. Find the "Publishing" section
3. Click the link to vscode-marketplace-setup.md
4. Verify it navigates correctly

### Automated Check

```bash
# Verify publishing section exists
grep -A 10 "## Publishing" /workspaces/generacy/README.md

# Verify link exists
grep "vscode-marketplace-setup.md" /workspaces/generacy/README.md

# Verify file link points to exists
test -f /workspaces/generacy/docs/publishing/vscode-marketplace-setup.md && echo "✅ Link target exists" || echo "❌ Link target missing"
```

## Integration

This task is part of Phase 5 (Documentation) and can run in parallel with T009 if you know the README structure in advance.

**Dependencies**:
- T008: Publishing directory must exist
- T009: Setup documentation must be created first

**Enables**:
- README provides clear navigation to publishing documentation
- New team members can discover publisher setup process
- CI/CD implementation (issues 1.6, 1.7) can reference documentation

## Time Estimate

- **Minimal README update**: 5 minutes (just add section and link)
- **Comprehensive README creation**: 15-20 minutes (full content from scratch)

## Success Criteria

✅ Publishing section exists in README.md
✅ Link to `/docs/publishing/vscode-marketplace-setup.md` is present and correct
✅ Link navigates successfully to the setup documentation
✅ README is well-formatted and professional
✅ Publishing infrastructure is clearly documented
