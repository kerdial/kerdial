import type { AccessTokenRecord } from "@kerdial/platform-auth";

/**
 * DTOs for `/auth/tokens` — ADR-0019; MCP-FR-5.
 *
 * The request schema is `@kerdial/api-contracts`' `accessTokenCreateBodySchema`,
 * imported by identity in the controller. The response never carries the
 * secret or its hash: the secret appears only once, beside the token, in the
 * `201` body of the create route (MCP-AC-2).
 *
 * Instants are ISO-8601 UTC strings; `status` is computed server-side so a
 * client does no date arithmetic.
 */
export interface AccessTokenResponse {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: "active" | "expired" | "revoked";
}

export interface AccessTokenListResponse {
  readonly items: readonly AccessTokenResponse[];
}

export interface AccessTokenCreatedResponse {
  readonly token: AccessTokenResponse;
  readonly secret: string;
}

/** Field by field rather than a spread, so a field added to the record cannot reach the wire unreviewed. */
export function toAccessTokenResponse(record: AccessTokenRecord): AccessTokenResponse {
  return {
    id: record.id,
    label: record.label,
    hint: record.hint,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    status: record.status,
  };
}
