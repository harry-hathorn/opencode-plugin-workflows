# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in opencode-plugin-workflows, please
report it **responsibly and privately** — do **not** open a public GitHub issue.

The preferred channel is GitHub's private vulnerability reporting:

- Go to the **Security** tab → **Report a vulnerability**, or
- <https://github.com/harry-hathorn/opencode-plugin-workflows/security/advisories/new>

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce (minimal example if possible).
- Affected version or commit.

## Scope Notes

Workflow scripts run in a hardened `node:vm` sandbox, but the plugin's whole
purpose is to spawn **real agent sessions that execute tools in your project
directory** — with your permissions. Treat any workflow script from an untrusted
source as executable code: the launch approval dialog shows the full script for
a reason. Worker sessions inherit the calling session's deny rules and are
denied `task`/`todowrite`, but they are not otherwise sandboxed.

## Response Expectations

- We will acknowledge receipt within **5 business days**.
- We will work with you on validation and coordinate a fix before any public
  disclosure.
- Responsible disclosure is appreciated and will be credited.

## Supported Versions

Only the latest release line receives security updates.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |
