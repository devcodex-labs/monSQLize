# Security Policy

## Supported Versions / 支持版本

Security fixes target the current published major line and its latest patch.
For the v3 release line, upgrade to the newest `3.x` patch before reporting.
Older majors may receive fixes only when the maintainers announce an extended
support window.

## Reporting a Vulnerability / 报告安全问题

Use [GitHub private vulnerability reporting](https://github.com/devcodex-labs/monSQLize/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

- Include the affected version, minimal reproduction, impact, and any known workaround.
- Maintainers aim to acknowledge a complete report within 72 hours, then coordinate validation, a fix, and a disclosure window through the private advisory.

## Sensitive Data / 敏感信息与日志

- Do not include credentials, private connection strings, or personal data in public issues, pull requests, examples, or logs.
- Redact production documents while keeping enough query shape and metadata to reproduce the issue.
