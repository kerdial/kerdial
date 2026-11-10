# Documentation

Guides for running, operating and feeding data into Kerdial.

| Document | What it covers |
| --- | --- |
| [`deploy-runbook.md`](deploy-runbook.md) | Installing and operating Kerdial with Docker Compose: bring-up, claiming the instance, the two exposure settings (`API_BIND`, `TRUST_PROXY`), the published image, upgrading from 0.1.x, taking and restoring a copy of the database, and tuning for slow hardware. |
| [`deploy-synology.md`](deploy-synology.md) | The same deployment on a Synology NAS: prerequisites, the `.env` for a reverse proxy on another machine, the nginx rule and its checks, and day-to-day operation on DSM. |
| [`run-local.md`](run-local.md) | Running Kerdial from source for development: the database container, seeding, environment variables. |
| [`import-export-format.md`](import-export-format.md) | The two export/import files (`kerdial-instruments.json`, `kerdial-transactions.csv`): the CSV dialect and its columns, a minimal hand-written example, how an import merges into existing data, and the limits. **Written in French**, like the interface. |
| [`release-notes.md`](release-notes.md) | What changed in each release, and any manual step an upgrade needs. |

To contribute, see [`CONTRIBUTING.md`](../CONTRIBUTING.md). To report a vulnerability, see
[`SECURITY.md`](../SECURITY.md).
