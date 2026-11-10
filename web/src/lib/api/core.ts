import { suggestedManualPriceSchema, type SuggestedManualPrice } from "@kerdial/api-contracts";
import { CSRF_COOKIE_NAME, readCookie } from "../cookies.js";

/**
 * Thin fetch wrapper over T-40's real `/api/v1/*` contract
 * (`api/src/auth/auth.controller.ts`, `api/src/portfolios/portfolios.controller.ts`):
 * same-origin (`/api/v1` — see `vite.config.ts`'s dev proxy and
 * the same-container prod topology), cookies included for the session
 * (`sid`), and the CSRF double-submit header
 * (`api/src/auth/cookies.ts`'s `CSRF_HEADER_NAME`) echoed on every
 * state-changing request. Errors are RFC 9457 `application/problem+json`
 * (`api/src/common/problem.ts`) — surfaced here as a typed `ApiError` rather
 * than a bare `Error`, so callers (the login screen) can branch on `code`.
 */
export const API_BASE = "/api/v1";
const CSRF_HEADER_NAME = "x-csrf-token";

interface ProblemBody {
  readonly title?: string;
  readonly detail?: string;
  readonly code?: string;
  /** RFC 9457 §3.2 extension members — see {@link ApiError.params}. */
  readonly params?: Readonly<Record<string, string | number>>;
  /** See {@link ApiError.suggestedPrice}. Unvalidated server JSON until the constructor parses it. */
  readonly suggestedPrice?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /**
   * The problem's extension members, kept rather than discarded.
   *
   * `code` alone can only ever produce one fixed sentence, which is how
   * « le taux de change nécessaire à cette valorisation n'est pas disponible »
   * ended up telling a user nothing they could act on — not which pair, not
   * for which date, though the server knew both. `problem-messages.ts` reads
   * these to say something specific.
   *
   * Scalars only, and never rendered wholesale: each message names the members
   * it expects. Nothing here is trusted into the DOM beyond React's own
   * escaping, and the server chooses each member explicitly rather than
   * spreading an error object (the same lesson as on the log side).
   */
  readonly params: Readonly<Record<string, string | number>>;
  /**
   * The manual price point a portfolio-level
   * `VALUATION_PRICE_UNAVAILABLE` offers to write (`@kerdial/api-contracts`'
   * `valuation-price-gap.ts`). Parsed against the contract, so a malformed
   * member is `undefined` — never a half-shaped object a button would post.
   */
  readonly suggestedPrice: SuggestedManualPrice | undefined;

  constructor(status: number, body: ProblemBody | undefined) {
    super(body?.detail ?? body?.title ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code;
    this.params = body?.params ?? {};
    const suggested = suggestedManualPriceSchema.safeParse(body?.suggestedPrice);
    this.suggestedPrice = suggested.success ? suggested.data : undefined;
  }
}

/**
 * `signal` — TanStack Query's own `QueryFunctionContext.signal` (`queries.ts`'s
 * `queryFn: ({ signal }) => ...`) — is a separate parameter, not folded into
 * `init`, so every GET wrapper in the sibling domain modules can accept it
 * without also having to
 * accept/merge an arbitrary `RequestInit` it never otherwise needed.
 * Forwarded straight to `fetch`: a GET that TanStack Query itself decides is
 * no longer wanted (`queryClient.clear()`/`removeQueries`, or a superseded
 * query key deactivating the previous observer — `LOW-2`'s instrument-search
 * debounce relies on exactly this) genuinely aborts, from the page's own
 * point of view, instead of silently completing after it is no longer
 * needed. `query-core`'s `Query.destroy()` -> `cancel()` -> the retryer's own
 * `AbortController.abort()` only fires this **if** the `queryFn` actually
 * read `context.signal` at least once (`query-core`'s `#abortSignalConsumed`
 * flag), which is why every GET wrapper in the sibling domain modules takes
 * and forwards it.
 *
 * ADR-0009 Stage 1 (`AR-21`): the old `session-cache.ts` purge machinery
 * (Cache Storage/IndexedDB/`BroadcastChannel`/cookies, called from
 * login/logout/guard-catch) is retired, and `in-flight-get-abort-on-purge.spec.ts`
 * — the spec proving a *purge's* `queryClient.clear()` aborts an in-flight
 * GET — was deleted with it. That does **not** mean `queryClient.clear()`
 * itself stopped aborting in-flight GETs: it still does, by the exact
 * `query-core` mechanism described above, wherever it is called. Two call
 * sites call it today, for a distinct, still-necessary reason (a
 * module-scope `QueryClient` singleton surviving a client-side session
 * change, `queries.ts`'s own note on `gcTime: Infinity`) — `LoginRoute.tsx`'s
 * `onSuccess` and `main.tsx`'s global 401 handler — and an in-flight GET
 * aborting when either of those fires is the same mechanism this comment
 * always described, not a partial revival of the retired purge.
 *
 * Mutations (`login`/`logout`/`createTransaction`) deliberately do not take a
 * `signal` — they are one-shot, user-initiated state changes, never
 * re-triggered by a query-cache eviction, so there is nothing here for them
 * to be threaded through.
 */
/*
 * `apiFetch`/`API_BASE` are internal to `lib/api/` — the `api-client.ts`
 * barrel deliberately does not re-export them, so the public surface is the
 * same set of typed endpoint wrappers it always was.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);

  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf !== undefined) headers.set(CSRF_HEADER_NAME, csrf);
  }
  // CI-21 (F-A). The
  // condition this default has always been guarded by is "a body exists", not
  // "the body is JSON" — so a `FormData` body was stamped
  // `content-type: application/json` **with no multipart boundary**, and no
  // server could ever have parsed its parts. `FormData` is the one body type
  // where the header is not the caller's to set: only the fetch implementation
  // knows the boundary it generated, and it fills the header in itself
  // *precisely when* the request carries none (the Fetch standard's "extract a
  // body" step is skipped for a header already present, which is why an
  // explicit one is not merely redundant here but actively destructive).
  //
  // Latent until now: the CSV import wizard is this codebase's first `FormData`
  // caller (VERIFIED — no other `new FormData()` exists in `web/src`). Every
  // other body still gets the default, and both kinds still carry
  // `x-csrf-token` (above) and `credentials: "include"` (below).
  if (
    init?.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    let body: ProblemBody | undefined;
    try {
      body = (await response.json()) as ProblemBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
