#!/bin/bash
# Verification script for T014: Fix imports in latency/common/

set -e

echo "========================================="
echo "T014 Verification: latency/common/ imports"
echo "========================================="
echo ""

COMMON_DIR="/workspaces/latency/packages/latency/src/common"

echo "1. Checking for imports without .js extension..."
MISSING_EXT=$(cd "$COMMON_DIR" && grep -n "from '\\./" *.ts 2>/dev/null | grep -v "\.js'" | wc -l)
if [ "$MISSING_EXT" -eq 0 ]; then
  echo "   ✅ All relative imports have .js extensions"
else
  echo "   ❌ Found $MISSING_EXT imports missing .js extension"
  cd "$COMMON_DIR" && grep -n "from '\\./" *.ts | grep -v "\.js'"
  exit 1
fi
echo ""

echo "2. Checking for legacy @generacy-ai/contracts imports..."
CONTRACTS_IMPORTS=$(cd "$COMMON_DIR" && grep -rn "@generacy-ai/contracts" --include="*.ts" . 2>/dev/null | wc -l)
if [ "$CONTRACTS_IMPORTS" -eq 0 ]; then
  echo "   ✅ No imports from @generacy-ai/contracts in TypeScript files"
else
  echo "   ❌ Found $CONTRACTS_IMPORTS imports from @generacy-ai/contracts"
  cd "$COMMON_DIR" && grep -rn "@generacy-ai/contracts" --include="*.ts" .
  exit 1
fi
echo ""

echo "3. Running TypeScript typecheck..."
cd /workspaces/latency/packages/latency
if pnpm typecheck 2>&1 | grep -q "error"; then
  echo "   ❌ TypeScript errors found"
  pnpm typecheck
  exit 1
else
  echo "   ✅ TypeScript typecheck passed"
fi
echo ""

echo "4. Building package..."
cd /workspaces/latency/packages/latency
if pnpm build 2>&1 | grep -q "error"; then
  echo "   ❌ Build failed"
  pnpm build
  exit 1
else
  echo "   ✅ Build succeeded"
fi
echo ""

echo "5. Analyzing import graph..."
echo "   Source files:"
cd "$COMMON_DIR"
for file in *.ts; do
  if [ "$file" != "index.ts" ]; then
    imports=$(grep "^import.*from '\\./" "$file" 2>/dev/null | wc -l || echo "0")
    if [ "$imports" -gt 0 ]; then
      echo "      $file → $(grep "^import.*from '\\./" "$file" | sed "s/.*from '\.\/\(.*\)\.js'.*/\1/" | tr '\n' ', ' | sed 's/,$//')"
    else
      echo "      $file (standalone)"
    fi
  fi
done
echo ""

echo "6. File count summary:"
SOURCE_FILES=$(cd "$COMMON_DIR" && find . -maxdepth 1 -name "*.ts" -type f | wc -l)
TEST_FILES=$(cd "$COMMON_DIR/__tests__" && find . -name "*.ts" -type f 2>/dev/null | wc -l || echo "0")
echo "   Source files: $SOURCE_FILES"
echo "   Test files: $TEST_FILES"
echo ""

echo "========================================="
echo "✅ T014 VERIFICATION COMPLETE"
echo "========================================="
echo ""
echo "All imports in latency/common/ are correctly formatted:"
echo "  - All relative imports use .js extensions"
echo "  - No legacy @generacy-ai/contracts imports"
echo "  - TypeScript compilation succeeds"
echo "  - Build succeeds"
echo ""
