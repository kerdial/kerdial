#!/bin/sh
# Kerdial, SH-27 — a tiny docker-entrypoint.sh that execs the
# right entrypoint on APP_ROLE so signals reach Node directly.
#
# `exec` is the whole point: Node becomes PID 1 of the container (compose also
# sets `init: true` — neither is load-bearing alone), so
# compose's SIGTERM reaches the process that registered the handlers rather
# than a shell that would ignore it and let the grace period expire into a
# SIGKILL. `worker-main.ts`'s explicit 25 s graceful drain is inert if the
# signal never arrives.
#
# This script is the *first* of two layers, and they are meant to agree:
# `api/src/app-role.ts` enforces the same decision inside the application, so a
# compose `command:` override or a hand-run `node api/dist/main.js` still
# cannot turn a worker container into a second HTTP server. It is deliberately
# not the only one.
set -eu

# Standard container convention: an explicit command wins. `docker run <image>
# id -u`, `docker compose run --rm api node ...` and a compose `command:` all
# arrive here as arguments and must run as written — the role dispatch is the
# *default* behaviour, not a cage. `app-role.ts` is the layer that still holds
# in that case.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

case "${APP_ROLE:-api}" in
api)
  exec node /app/api/dist/main.js
  ;;
worker)
  # `worker-main.js` runs itself when it *is* the process entrypoint (its own
  # `import.meta.url === argv[1]` guard); this is the invocation that guard was
  # written for. Reaching it does not evaluate `api/src/app.js` at all — no
  # Nest container, no Fastify instance, nothing that could bind a port.
  exec node /app/market/composition/dist/worker-main.js
  ;;
*)
  # Fail closed, but with **one** error message in the codebase rather than a
  # second copy that could drift: `main.js` calls `parseAppRole`, which throws
  # naming the variable, the value and why guessing is unacceptable (SH-21), and
  # exits non-zero. Note this branch is only reached for values `app-role.ts`
  # also rejects — it tolerates surrounding whitespace and case, so e.g.
  # `APP_ROLE=" WORKER "` lands here and is then dispatched correctly by the
  # application layer instead of being refused.
  exec node /app/api/dist/main.js
  ;;
esac
