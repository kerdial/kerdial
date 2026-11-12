import { apiFetch } from "./core.js";

/**
 * `/api/v1/auth/tokens` — the caller's personal access tokens (ADR-0019;
 * MCP-FR-2, MCP-FR-5, MCP-FR-6, MCP-L17).
 *
 * The wire shapes are mirrored from the API's DTOs: `web` may not import
 * `api` at runtime. Instants are ISO-8601 UTC strings and `status` is computed
 * by the server, so the card does no date arithmetic.
 *
 * **The secret.** It exists in exactly one response, the `201` of
 * {@link createAccessToken}, which the API serves `no-store` and the service
 * worker never caches (`/api/v1/**` is `NetworkOnly`). On this side it lives
 * only in the create mutation's result and the dialog's state.
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

/** The create body, `accessTokenCreateBodySchema`'s output shape (`@kerdial/api-contracts`). */
export interface AccessTokenCreateInput {
  readonly label: string;
  /** `null` is « Jamais » (MCP-L2). */
  readonly expiresInDays: number | null;
  /** MCP-L17: creating a token re-authenticates, like `PATCH /auth/me`. */
  readonly currentPassword: string;
}

/** `GET /auth/tokens` — the caller's tokens, newest first, at most 50. */
export function fetchAccessTokens(signal?: AbortSignal): Promise<AccessTokenListResponse> {
  return apiFetch<AccessTokenListResponse>("/auth/tokens", undefined, signal);
}

/**
 * `POST /auth/tokens` — `201 { token, secret }`.
 *
 * Two different `401`s answer here, told apart by `code`:
 * `CURRENT_PASSWORD_INCORRECT` (a typo — the dialog shows it on the field) and
 * `UNAUTHENTICATED` (the session ended while the request waited). The mutation
 * calling this must carry `meta: { skipGlobal401: true }` so neither one
 * navigates away mid-dialog.
 */
export function createAccessToken(
  input: AccessTokenCreateInput,
): Promise<AccessTokenCreatedResponse> {
  return apiFetch<AccessTokenCreatedResponse>("/auth/tokens", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `POST /auth/tokens/:id/revoke` — `204`; `404 ACCESS_TOKEN_NOT_FOUND` when unknown or already revoked. */
export function revokeAccessToken(id: string): Promise<void> {
  return apiFetch<void>(`/auth/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}
