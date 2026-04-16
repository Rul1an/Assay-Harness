# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | Current release only |

## Reporting a vulnerability

If you discover a security vulnerability in Assay-Harness, please report it through one of the following channels:

- **Email:** security@assay.dev
- **GitHub:** Use [private vulnerability reporting](https://github.com/Rul1an/Assay-Harness/security/advisories/new)

Do **not** open a public issue for security vulnerabilities.

## Key policies

- **No secrets in fixtures.** Test fixtures must never contain real API keys, tokens, or credentials.
- **No API keys in issues.** Never include API keys or secrets in bug reports or feature requests.
- **Suspected evidence forgery** must be reported via private disclosure, not public issues.

## Scope

The following categories are in scope for security reports:

- **Policy bypass** -- circumventing approval gates or policy enforcement
- **Artifact manipulation** -- tampering with evidence records or harness output
- **Hash collision** -- exploiting weaknesses in evidence integrity checks
- **Evidence boundary violation** -- leaking data across evidence boundaries (e.g., transcript truth, session truth, or raw state appearing in compiled evidence)
