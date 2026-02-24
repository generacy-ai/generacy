#!/bin/bash
# T001: npm Organization Access Verification Script
# This script helps verify npm organization access and document current state

set -e

SPEC_DIR="/workspaces/generacy/specs/242-1-1-set-up"
ORG_NAME="generacy-ai"
PACKAGES=("@generacy-ai/latency" "@generacy-ai/agency" "@generacy-ai/generacy")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}npm Organization Access Verification${NC}"
echo -e "${BLUE}Organization: @${ORG_NAME}${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if logged in
echo -e "${YELLOW}[1/6] Checking npm authentication...${NC}"
if ! npm whoami &>/dev/null; then
    echo -e "${RED}❌ Not logged in to npm${NC}"
    echo -e "${YELLOW}Please run: npm login${NC}"
    exit 1
fi

USERNAME=$(npm whoami)
echo -e "${GREEN}✅ Logged in as: ${USERNAME}${NC}"
echo ""

# Check organization membership
echo -e "${YELLOW}[2/6] Checking organization membership...${NC}"
if ! npm org ls "${ORG_NAME}" &>/dev/null; then
    echo -e "${RED}❌ Cannot access organization @${ORG_NAME}${NC}"
    echo -e "${YELLOW}Possible reasons:${NC}"
    echo "  - Organization doesn't exist"
    echo "  - You're not a member"
    echo "  - Insufficient permissions"
    exit 1
fi

echo -e "${GREEN}✅ Access to @${ORG_NAME} confirmed${NC}"
echo ""

# Get organization members
echo -e "${YELLOW}[3/6] Fetching organization members...${NC}"
ORG_MEMBERS_FILE="${SPEC_DIR}/org-members.json"
if npm org ls "${ORG_NAME}" --json > "${ORG_MEMBERS_FILE}" 2>/dev/null; then
    echo -e "${GREEN}✅ Members saved to: ${ORG_MEMBERS_FILE}${NC}"

    # Pretty print members
    echo ""
    echo "Current members:"
    if command -v jq &>/dev/null; then
        cat "${ORG_MEMBERS_FILE}" | jq -r 'to_entries | .[] | "  - \(.key): \(.value)"'
    else
        cat "${ORG_MEMBERS_FILE}"
        echo -e "${YELLOW}💡 Install jq for prettier output: npm install -g jq${NC}"
    fi
else
    echo -e "${RED}❌ Failed to fetch organization members${NC}"
fi
echo ""

# Check package access
echo -e "${YELLOW}[4/6] Checking package access...${NC}"
PACKAGES_FILE="${SPEC_DIR}/org-packages.json"
if npm access ls-packages "${ORG_NAME}" --json > "${PACKAGES_FILE}" 2>/dev/null; then
    echo -e "${GREEN}✅ Package access saved to: ${PACKAGES_FILE}${NC}"

    # Pretty print packages
    echo ""
    echo "Packages in organization:"
    if command -v jq &>/dev/null; then
        PACKAGE_COUNT=$(cat "${PACKAGES_FILE}" | jq 'length')
        if [ "${PACKAGE_COUNT}" -eq 0 ]; then
            echo "  (No packages published yet)"
        else
            cat "${PACKAGES_FILE}" | jq -r 'to_entries | .[] | "  - \(.key): \(.value)"'
        fi
    else
        cat "${PACKAGES_FILE}"
    fi
else
    echo -e "${YELLOW}⚠️  Could not fetch package access list${NC}"
    echo "  This might be normal if no packages are published yet"
fi
echo ""

# Check individual packages
echo -e "${YELLOW}[5/6] Checking individual package status...${NC}"
for package in "${PACKAGES[@]}"; do
    echo -n "  Checking ${package}... "
    if npm info "${package}" --json > "${SPEC_DIR}/$(basename ${package})-info.json" 2>/dev/null; then
        VERSION=$(cat "${SPEC_DIR}/$(basename ${package})-info.json" | jq -r '.version // "unknown"')
        echo -e "${GREEN}✅ Published (v${VERSION})${NC}"
    else
        echo -e "${YELLOW}⚠️  Not published yet${NC}"
        rm -f "${SPEC_DIR}/$(basename ${package})-info.json"
    fi
done
echo ""

# Check if user can publish
echo -e "${YELLOW}[6/6] Checking publish permissions...${NC}"
echo "Current user: ${USERNAME}"

# Try to get user's role in the organization
if command -v jq &>/dev/null && [ -f "${ORG_MEMBERS_FILE}" ]; then
    USER_ROLE=$(cat "${ORG_MEMBERS_FILE}" | jq -r --arg user "${USERNAME}" '.[$user] // "not found"')
    echo "Your role: ${USER_ROLE}"

    case "${USER_ROLE}" in
        "owner"|"admin")
            echo -e "${GREEN}✅ You have publish permissions${NC}"
            ;;
        "developer")
            echo -e "${YELLOW}⚠️  Developer role - may have limited permissions${NC}"
            ;;
        "not found")
            echo -e "${RED}❌ User not found in organization${NC}"
            ;;
        *)
            echo -e "${YELLOW}⚠️  Unknown role: ${USER_ROLE}${NC}"
            ;;
    esac
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Verification Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "✅ Authenticated as: ${USERNAME}"
echo -e "✅ Organization: @${ORG_NAME}"
echo -e "📁 Output files in: ${SPEC_DIR}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Review the generated JSON files for detailed information"
echo "2. Complete the manual verification checklist in T001-npm-org-verification.md"
echo "3. Verify automation user access (if different from ${USERNAME})"
echo "4. Generate npm token for GitHub Actions (if needed)"
echo ""
echo -e "${GREEN}Verification script completed!${NC}"
