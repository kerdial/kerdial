# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/kerdial/kerdial/security/advisories/new) on
`kerdial/kerdial`. Do not open a public issue or discussion.

If you cannot use GitHub, email **contact@kerdial.com** with "Security" in the subject.

Include what you can: the affected version, endpoint or module, steps to reproduce, and the impact you
expect (for example, bypassing authentication, gaining admin rights without them, or corrupting stored
figures).

## What to expect

Kerdial is maintained by one person, so responses are best effort. I aim to acknowledge a report within
a week and to keep you informed while a fix is prepared. Once a fixed release is published, the advisory
is made public and you are credited unless you prefer otherwise.

## Supported versions

Only the latest minor release receives security fixes. Kerdial is pre-1.0; currently that is **0.2.x**.
Upgrade to the latest release before reporting, if you can.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Scope

Kerdial is self-hosted software; there is no public instance to test against. Please test on your own
installation. Of particular interest are the properties the application explicitly relies on:

- Tenant isolation enforced by PostgreSQL row-level security on every tenant-owned table (defence in
  depth). One instance normally holds one household tenant: every user the admin creates joins it and
  sees the same portfolios by design, so one user of an instance reading another's data is not a
  vulnerability. Isolation between households comes from running separate instances.
- Session authentication, CSRF protection and login rate limiting.
- Integrity of financial figures (decimal-only arithmetic, provenance and freshness of displayed values).

Out of scope: the reverse proxy, TLS and network exposure of your own deployment, which Kerdial does not
manage (see [`docs/deploy-runbook.md`](docs/deploy-runbook.md)).
