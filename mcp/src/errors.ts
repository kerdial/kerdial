/**
 * What can go wrong talking to Kerdial, and the one sentence a tool returns
 * for each (`isError: true`). No message carries the token, a request path or
 * query, or a problem's `detail` (which may quote user data): an API problem
 * contributes its `title`, `code`, scalar `params` and the names of the fields
 * it rejected, and a transport failure names the configured host only.
 */

export type KerdialFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden"; readonly code: string | undefined }
  | { readonly kind: "not-found"; readonly code: string | undefined }
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly title: string | undefined;
      readonly code: string | undefined;
      readonly params: Readonly<Record<string, string | number>>;
      readonly fields: readonly string[];
    }
  | {
      readonly kind: "rate-limited";
      readonly code: string | undefined;
      readonly retryAfterSeconds: number | undefined;
    }
  | { readonly kind: "unreachable"; readonly reason: string };

export class KerdialError extends Error {
  override readonly name = "KerdialError";
  constructor(readonly failure: KerdialFailure) {
    super(failure.kind);
  }
}

const TOKEN_REJECTED =
  "The Kerdial access token is invalid, expired or revoked. Create a new one in Kerdial (Mon compte → Accès pour assistants IA).";

const TOKEN_CANNOT =
  "This access token cannot do that: it is read-only and limited to portfolio reads.";

export function toolErrorText(failure: KerdialFailure, host: string): string {
  switch (failure.kind) {
    case "unauthorized":
      return TOKEN_REJECTED;
    case "forbidden":
      return failure.code === undefined ? TOKEN_CANNOT : `${TOKEN_CANNOT} (${failure.code})`;
    case "not-found":
      return `No such portfolio or resource (${failure.code ?? "NOT_FOUND"}).`;
    case "rejected": {
      const parts = [
        `Kerdial refused the request (HTTP ${failure.status}${failure.code === undefined ? "" : ` ${failure.code}`})`,
      ];
      if (failure.title !== undefined) parts.push(failure.title);
      const params = Object.entries(failure.params).map(([key, value]) => `${key}=${value}`);
      if (params.length > 0) parts.push(`details: ${params.join(", ")}`);
      if (failure.fields.length > 0) parts.push(`invalid fields: ${failure.fields.join(", ")}`);
      return `${parts.join(": ")}.`;
    }
    case "rate-limited":
      return failure.retryAfterSeconds === undefined
        ? `Kerdial is rate-limiting this token (${failure.code ?? "429"}); retry later.`
        : `Kerdial is rate-limiting this token (${failure.code ?? "429"}); retry after ${failure.retryAfterSeconds} s.`;
    case "unreachable":
      return `Kerdial at ${host} is unreachable or answered unexpectedly (${failure.reason}).`;
  }
}
