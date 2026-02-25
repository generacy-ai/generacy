# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

### Preferred: GitHub Security Advisories

Use [GitHub Security Advisories](https://github.com/generacy-ai/generacy/security/advisories/new) to privately report a vulnerability. This allows us to collaborate on a fix before public disclosure.

### Alternative: Email

If you are unable to use GitHub Security Advisories, you can email us at **security@generacy.ai**. Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (if applicable)

## Scope

The following are considered security issues:

- Authentication or authorization bypasses
- Credential or secret exposure
- Remote code execution
- Injection vulnerabilities (SQL, command, etc.)
- Cross-site scripting (XSS) or cross-site request forgery (CSRF)
- Data exposure or privacy violations
- Dependency vulnerabilities with a plausible exploit path

The following are **not** considered security issues and should be reported as regular [bug reports](https://github.com/generacy-ai/generacy/issues):

- Denial of service through excessive resource consumption in local development tools
- Issues requiring physical access to a user's machine
- Social engineering attacks
- Bugs that do not have a security impact

## Supported Versions

This project is in early development. All security reports will be evaluated against the latest code on the default branch.

## Response Timeline

| Action | Target |
|--------|--------|
| Acknowledgment of report | Within 48 hours |
| Initial assessment | Within 1 week |
| Target fix release | Within 90 days |

We will keep you informed of our progress throughout the process.

## Disclosure Policy

We follow a **coordinated disclosure** model:

1. The reporter submits a vulnerability through the channels above.
2. We acknowledge receipt and begin investigation.
3. We work on a fix and coordinate a disclosure timeline with the reporter.
4. The fix is released, and the vulnerability is disclosed publicly after the patch is available.

We kindly ask that you do not disclose the vulnerability publicly until we have had a chance to address it.
