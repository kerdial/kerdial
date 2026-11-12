/**
 * ADR-0019 — the one parse of an `Authorization` header.
 *
 * Only the `Bearer` scheme (compared case-insensitively) selects the
 * personal-access-token path. Any other scheme — `Basic …` forwarded by a
 * reverse proxy that runs its own basic auth — answers `undefined`, and the
 * request continues on the cookie path exactly as before this header was
 * ever read; refusing it would 401 every cookie user behind such a proxy.
 *
 * A `Bearer` header with no credential answers `""`: it did select the token
 * path, and the empty string then fails validation like any other bad token.
 */
export function bearerCredential(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  const scheme = space === -1 ? trimmed : trimmed.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return undefined;
  return space === -1 ? "" : trimmed.slice(space).trim();
}
