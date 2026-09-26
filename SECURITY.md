# Security

YEA is an authorization protocol. Security bugs are the most valuable reports we get.

**Please report vulnerabilities privately** through
[GitHub security advisories](https://github.com/yea-protocol/yea/security/advisories/new).
Don't open a public issue. We aim to respond within 72 hours.

In scope: the spec (SPEC.md), the TypeScript reference (`ts/`), the Python implementation
(`python/`), the CLI, and the MCP bridge. Especially:

- anything that lets an agent act beyond its grant's caveats, or without a required consent
- anything that gets a principal to sign something other than what they were shown
- replay, idempotency or spend-accounting bypasses
- crashes or unbounded resource use from unauthenticated input

Past findings and their fixes are listed in [docs/design.md](docs/design.md#security-review).

## Deployment guidance

- Keep the **principal key** where agents can't read it: another OS user, another machine,
  or a phone (`YEA_PRINCIPAL_HOME`). An agent that can read it can sign its own consent.
- Use short-lived grants (`exp`), and pair `per` with `spend`.
- Run YEA over an authenticated transport (`yeas://`, `https://`).
