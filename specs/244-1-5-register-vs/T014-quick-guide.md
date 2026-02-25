# T014 Quick Guide: Dry-Run Publish Test

**Status**: ✅ COMPLETED | **Type**: Optional Verification | **Time**: ~10 minutes

## Quick Summary

Validated VS Code extension packaging using `vsce package` command. Successfully created test VSIX package without publishing.

## Commands Used

```bash
# 1. Create test extension directory
mkdir -p /tmp/test-vsce-extension
cd /tmp/test-vsce-extension

# 2. Create minimal package.json with publisher
cat > package.json <<'EOF'
{
  "name": "test-vsce-extension",
  "publisher": "generacy-ai",
  "version": "0.0.1",
  "engines": { "vscode": "^1.85.0" }
}
EOF

# 3. Verify vsce is installed
vsce --version

# 4. Package extension (dry-run equivalent)
vsce package
```

## Key Findings

- ✅ `vsce package` is the correct dry-run approach (no `--dry-run` flag exists)
- ✅ Publisher `generacy-ai` validated successfully
- ✅ VSIX package created: 2.43 KB (6 files)
- ⚠️ LICENSE and .vscodeignore warnings (expected for test)

## Result

**SUCCESS** - Extension packaging workflow validated, ready for actual publishing.

## See Also

- [T014-completion-summary.md](./T014-completion-summary.md) - Full details
- [tasks.md](./tasks.md) - Task specification (lines 165-171)
