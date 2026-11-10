import { HttpException } from "@nestjs/common";
import type { SuggestedManualPrice } from "@kerdial/api-contracts";

/**
 * RFC 9457 `application/problem+json` body: "errors
 * are RFC 9457 `application/problem+json`". Shared by every controller/guard
 * in this app (not just `/auth/*`) so T-37/T-38/T-39 reuse the same shape.
 */
/** One field-level validation failure — T-37's AC12: "rejects a malformed one ... with a per-field problem+json error." */
export interface ProblemFieldError {
  readonly field: string;
  readonly message: string;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /** Machine-readable error code, e.g. `"INVALID_CREDENTIALS"`. Not part of RFC 9457 itself, but a common, documented extension. */
  readonly code?: string;
  /** Per-field validation errors, when the failure is a request-body/query shape violation (`zod-validate.ts`'s `parseOrThrow`). Not part of RFC 9457 itself, but a common, documented extension (mirrors `code`). */
  readonly errors?: readonly ProblemFieldError[];
  /**
   * RFC 9457 §3.2 extension members — the few machine-readable facts a client
   * needs to say something *specific* about this failure.
   *
   * Added because « le taux de change nécessaire n'est pas disponible » told a
   * user nothing they could act on: not which currency pair, not for which
   * date. The server knew both. Values are scalars only, and each one is
   * chosen per call site — this is deliberately **not** a place to spread an
   * error object into, which is how a message or a bound parameter would leak
   * (see `ProblemJsonExceptionFilter`'s own field allow-list).
   */
  readonly params?: Readonly<Record<string, string | number>>;
  /**
   * `VALUATION_PRICE_UNAVAILABLE` on a portfolio-level read only:
   * the manual price point the client may offer to write. Its own typed
   * member rather than three loose `params` scalars, so it can only ever be the
   * contract's shape — still built field by field at the one call site, never
   * spread from an error or a row.
   */
  readonly suggestedPrice?: SuggestedManualPrice;
}

export interface ProblemOptions {
  readonly title: string;
  readonly detail?: string;
  readonly code?: string;
  readonly type?: string;
  readonly errors?: readonly ProblemFieldError[];
  /** See {@link ProblemDetails.params}. Scalars only, named explicitly per call site. */
  readonly params?: Readonly<Record<string, string | number>>;
  /** See {@link ProblemDetails.suggestedPrice}. */
  readonly suggestedPrice?: SuggestedManualPrice;
}

/**
 * Builds an `HttpException` whose response body is already problem+json
 * shaped. `ProblemJsonExceptionFilter` (this directory) is what actually
 * serialises it with the `application/problem+json` content type — this
 * function only builds the payload, so it can be thrown from a guard, a
 * pipe, or a controller alike.
 */
export function problemException(status: number, options: ProblemOptions): HttpException {
  const body: ProblemDetails = {
    type: options.type ?? "about:blank",
    title: options.title,
    status,
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.errors !== undefined ? { errors: options.errors } : {}),
    ...(options.params !== undefined ? { params: options.params } : {}),
    ...(options.suggestedPrice !== undefined
      ? {
          suggestedPrice: {
            date: options.suggestedPrice.date,
            close: options.suggestedPrice.close,
            currency: options.suggestedPrice.currency,
          },
        }
      : {}),
  };
  return new HttpException(body, status);
}
