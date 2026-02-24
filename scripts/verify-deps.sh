#!/bin/bash
set -euo pipefail

# verify-deps.sh - Verify @generacy-ai dependencies are published to npm
# Usage: ./scripts/verify-deps.sh <dist-tag>
# Example: ./scripts/verify-deps.sh preview
# Example: ./scripts/verify-deps.sh latest

DIST_TAG="${1:-latest}"

if [[ "$DIST_TAG" != "preview" && "$DIST_TAG" != "latest" ]]; then
  echo "Error: dist-tag must be 'preview' or 'latest'"
  echo "Usage: $0 <dist-tag>"
  exit 1
fi

echo "🔍 Verifying @generacy-ai dependencies with dist-tag: $DIST_TAG"
echo ""

# Parse package.json for @generacy-ai dependencies
PACKAGE_JSON="package.json"
if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "Error: package.json not found in current directory"
  exit 1
fi

# Extract @generacy-ai/* dependencies from package.json
# This includes both dependencies and devDependencies
DEPS=$(node -e "
const pkg = require('./package.json');
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const generacyDeps = Object.keys(deps).filter(name => name.startsWith('@generacy-ai/'));
console.log(generacyDeps.join(' '));
")

if [[ -z "$DEPS" ]]; then
  echo "✅ No @generacy-ai dependencies found - verification passed"
  exit 0
fi

echo "📦 Found dependencies: $DEPS"
echo ""

# Check each dependency
FAILED=0
for DEP in $DEPS; do
  echo "Checking $DEP@$DIST_TAG..."

  # Try to get package info from npm
  if npm view "$DEP@$DIST_TAG" version &>/dev/null; then
    VERSION=$(npm view "$DEP@$DIST_TAG" version)
    echo "  ✅ $DEP@$DIST_TAG exists (version: $VERSION)"
  else
    echo "  ❌ $DEP@$DIST_TAG not found on npm registry"
    FAILED=1
  fi
  echo ""
done

if [[ $FAILED -eq 1 ]]; then
  echo "❌ Dependency verification failed"
  echo ""
  echo "Some @generacy-ai dependencies are not published with the $DIST_TAG dist-tag."
  echo "Please ensure all dependencies are published before publishing this package."
  echo ""
  echo "Expected dependencies: $DEPS"
  exit 1
fi

echo "✅ All @generacy-ai dependencies verified with dist-tag: $DIST_TAG"
exit 0
