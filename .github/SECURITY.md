# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in @oui-spec, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email security@closurestudio.com with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if you have one)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Measures

- All dependencies are audited on every CI run
- npm provenance is enabled for published packages (supply chain attestation)
- Package contents are verified before every publish
- Multi-Node version testing (18, 20, 22) ensures compatibility
