import { ACCESS_TOKEN_PREFIX } from "@kerdial/platform-auth";

/**
 * ADR-0019 — the one parse of an `Authorization` header.
 *
 * Only a Kerdial-shaped credential selects the personal-access-token path:
 * the `Bearer` scheme (compared case-insensitively) followed by a credential
 * that starts with `kdl_pat_` (case-sensitive, as issued). Everything else —
 * another scheme such as `Basic …`, a `Bearer` carrying a foreign credential
 * (an OIDC or JWT token a reverse proxy injects: oauth2-proxy's
 * `--pass-authorization-header`, a forward-auth middleware), an empty
 * `Bearer` — answers `undefined`, and the request continues on the cookie
 * path exactly as if the header were absent. Claiming such a header would
 * 401 every cookie user behind that proxy, and count each of their requests
 * as a failed token authentication.
 *
 * A `kdl_pat_…` credential is always the token path, valid or not: a
 * malformed, unknown, expired or revoked one is then refused by validation
 * with no cookie fallback.
 */
export function bearerCredential(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  if (space === -1) return undefined;
  if (trimmed.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const credential = trimmed.slice(space).trim();
  return credential.startsWith(ACCESS_TOKEN_PREFIX) ? credential : undefined;
}
