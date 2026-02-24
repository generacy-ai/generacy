#!/bin/bash
# Verification script for #237 implementation
# Run this before manual integration test to verify code is ready

set -e

echo "========================================"
echo "Feature #237 Implementation Verification"
echo "========================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
PASS=0
FAIL=0

# Helper function
check() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $1"
        ((PASS++))
    else
        echo -e "${RED}✗${NC} $1"
        ((FAIL++))
    fi
}

echo "1. Checking implementation files exist..."
[ -f "/workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts" ]
check "label-manager.ts exists"

[ -f "/workspaces/generacy/packages/orchestrator/src/worker/__tests__/label-manager.test.ts" ]
check "label-manager.test.ts exists"

echo ""
echo "2. Checking code implementation..."

# Check for the critical line: addLabels with agent:in-progress
grep -q "await this.github.addLabels.*\['agent:in-progress'\]" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts
check "onResumeStart() calls addLabels with 'agent:in-progress'"

# Check for the log message
grep -q "Resume: adding agent:in-progress label" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts
check "Log message 'Resume: adding agent:in-progress label' present"

# Check for comment
grep -q "Add agent:in-progress to reflect active workflow state" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts
check "Explanatory comment present"

echo ""
echo "3. Checking test updates..."

# Check test file for addLabels assertion
grep -q "expect(mockGithub.addLabels).*'agent:in-progress'" \
    /workspaces/generacy/packages/orchestrator/src/worker/__tests__/label-manager.test.ts
check "Test verifies addLabels called with 'agent:in-progress'"

# Count test assertions for addLabels in onResumeStart tests
COUNT=$(grep -c "expect(mockGithub.addLabels)" \
    /workspaces/generacy/packages/orchestrator/src/worker/__tests__/label-manager.test.ts || echo "0")

if [ "$COUNT" -ge 2 ]; then
    echo -e "${GREEN}✓${NC} At least 2 test assertions for addLabels found"
    ((PASS++))
else
    echo -e "${RED}✗${NC} Expected at least 2 test assertions for addLabels, found $COUNT"
    ((FAIL++))
fi

echo ""
echo "4. Running unit tests..."
cd /workspaces/generacy/packages/orchestrator

# Run tests and capture output
TEST_OUTPUT=$(pnpm test -- label-manager.test.ts 2>&1)
TEST_EXIT=$?

if [ $TEST_EXIT -eq 0 ]; then
    echo -e "${GREEN}✓${NC} All label-manager tests pass"
    ((PASS++))

    # Count passed tests
    TEST_COUNT=$(echo "$TEST_OUTPUT" | grep -oP '\d+(?= passed)' | tail -1)
    echo "  Tests passed: $TEST_COUNT"
else
    echo -e "${RED}✗${NC} Some tests failed"
    ((FAIL++))
    echo "$TEST_OUTPUT" | grep -A 5 "FAIL"
fi

echo ""
echo "5. Checking code structure..."

# Verify the addLabels is inside retryWithBackoff
LINE_RETRY=$(grep -n "async onResumeStart" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts | cut -d: -f1)
LINE_ADD=$(grep -n "await this.github.addLabels.*agent:in-progress" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts | cut -d: -f1)
LINE_END=$(grep -n "^  }$" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts | \
    awk -v start=$LINE_RETRY '$1 > start {print $1; exit}')

if [ "$LINE_ADD" -gt "$LINE_RETRY" ] && [ "$LINE_ADD" -lt "$LINE_END" ]; then
    echo -e "${GREEN}✓${NC} addLabels call is inside onResumeStart method"
    ((PASS++))
else
    echo -e "${RED}✗${NC} addLabels call might not be in correct location"
    ((FAIL++))
fi

# Check that addLabels comes after removeLabels
LINE_REMOVE=$(grep -n "await this.github.removeLabels" \
    /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts | \
    grep -A 20 "onResumeStart" | head -1 | cut -d: -f1)

if [ "$LINE_ADD" -gt "$LINE_REMOVE" ]; then
    echo -e "${GREEN}✓${NC} addLabels called after removeLabels (correct order)"
    ((PASS++))
else
    echo -e "${YELLOW}⚠${NC}  Warning: addLabels might be called before removeLabels"
    ((FAIL++))
fi

echo ""
echo "6. Checking worker integration..."

# Verify worker calls onResumeStart
grep -q "await labelManager.onResumeStart()" \
    /workspaces/generacy/packages/orchestrator/src/worker/claude-cli-worker.ts
check "Worker calls labelManager.onResumeStart()"

# Check it's in the right place (after command === 'continue' check)
CONTEXT=$(grep -B 2 "await labelManager.onResumeStart()" \
    /workspaces/generacy/packages/orchestrator/src/worker/claude-cli-worker.ts)

if echo "$CONTEXT" | grep -q "item.command === 'continue'"; then
    echo -e "${GREEN}✓${NC} onResumeStart() called in resume flow (command === 'continue')"
    ((PASS++))
else
    echo -e "${RED}✗${NC} onResumeStart() might not be in correct flow"
    ((FAIL++))
fi

echo ""
echo "========================================"
echo "Verification Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ Implementation is ready for manual integration testing${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Start the development stack"
    echo "  2. Start the orchestrator (cd packages/orchestrator && pnpm dev)"
    echo "  3. Follow manual-integration-test.md to test on a real issue"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Implementation has issues - fix before manual testing${NC}"
    echo ""
    echo "Review the failures above and fix the code before proceeding."
    echo ""
    exit 1
fi
