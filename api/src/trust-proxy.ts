/**
 * Fastify's `trustProxy` option shape, minus the callback form (a
 * `TrustProxyFunction` isn't exported by `fastify`'s own typings, and this
 * app has no need for it — a hop count or an explicit CIDR/IP list already
 * covers every real deployment topology this app runs behind).
 */
export type TrustProxyOption = boolean | string | string[] | number;

/**
 * Security review finding M2: with Fastify's default `trustProxy: false`
 * behind a TLS-terminating reverse proxy, `request.ip` resolves to the
 * *proxy's* address for every client — the login rate limiter keys
 * part of its decision on `request.ip` (per-IP backoff/lockout),
 * so that collapses into a single shared key (a
 * self-inflicted denial-of-service: one real attacker locks out every other
 * client behind the same proxy) and gives zero actual per-attacker signal.
 *
 * The fix is **not** `trustProxy: true` — that trusts every hop
 * unconditionally, which means any client can set its own `X-Forwarded-For`
 * header and choose whatever `request.ip` it wants, defeating the rate
 * limiter in the opposite direction (spoofing a fresh IP per attempt).
 *
 * Instead, this is a deployment-configured trust boundary: `TRUST_PROXY`
 * names either a hop count (an integer — "trust exactly this many hops
 * counting from the socket peer") or a comma-separated list of the known
 * proxy's own IP(s)/CIDR(s), matching Fastify's own `trustProxy` shape
 * (`boolean | string | string[] | number`). **A real deployment behind a
 * reverse proxy MUST set this to that proxy's own address/CIDR (or a hop
 * count of exactly how many proxies sit in front of the app) — never to a
 * blanket `true`.** Left unset (or set to `"false"`), this defaults to the
 * safe value: trust nothing, `request.ip` is always the real TCP peer.
 *
 * Between SH-26 and ADR-0016 this knob was superseded by a
 * derived `PROXY_TOPOLOGY` control with a per-request monitor and a deploy-time
 * probe. That control was built for an internet-exposed, cross-host topology
 * and is retired; `TRUST_PROXY` is again the one deployment setting, read by
 * `api-runtime.ts`'s `wireTrustProxy` and nowhere else.
 */
export const TRUST_PROXY_ENV_VAR = "TRUST_PROXY";

export function parseTrustProxy(raw: string | undefined): TrustProxyOption {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return false;

  const hopCount = Number(trimmed);
  if (Number.isInteger(hopCount) && hopCount > 0) return hopCount;

  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
