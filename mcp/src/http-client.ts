import type { KerdialConfig } from "./config.js";
import { KerdialError } from "./errors.js";

/**
 * The only way this package reaches Kerdial: `GET` over the HTTP API with the
 * Bearer token. Bodies are parsed with `JSON.parse` and nothing else — the API
 * sends every amount as a JSON string, so parsing keeps it byte for byte; the
 * only JSON numbers on the wire are counts.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface KerdialClientOptions {
  /** Defaults to the global `fetch`. Injected by tests. */
  readonly fetch?: FetchLike;
  /** Waits before the single bounded 429 retry. Injected by tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Diagnostic sink (stderr in `main.ts`), used only when `config.debug` is set. */
  readonly log?: (line: string) => void;
  /** Sent as `User-Agent: kerdial-mcp/<version>`. */
  readonly version?: string;
}

export type QueryParams = Readonly<Record<string, string | undefined>>;

/** Larger than any page this package asks for; a body past it is refused, not truncated. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A `Retry-After` longer than this is reported, never waited for. */
const MAX_RETRY_AFTER_SECONDS = 10;

const JSON_MEDIA_TYPES = new Set(["application/json", "application/problem+json"]);

export class KerdialClient {
  readonly #config: KerdialConfig;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: ((line: string) => void) | undefined;
  readonly #userAgent: string;

  constructor(config: KerdialConfig, options: KerdialClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.#log = config.debug ? options.log : undefined;
    this.#userAgent = `kerdial-mcp/${options.version ?? "0.0.0"}`;
  }

  /** `GET /api/v1<path>?<query>`; resolves to the parsed body, or throws a {@link KerdialError}. */
  async get(path: string, query: QueryParams = {}): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, value);
    }
    const qs = search.toString();
    const url = `${this.#config.baseUrl}/api/v1${path}${qs === "" ? "" : `?${qs}`}`;

    const first = await this.#attempt(path, url);
    if (first.kind !== "retry") return first.body;
    await this.#sleep(first.seconds * 1000);
    const second = await this.#attempt(path, url);
    if (second.kind !== "retry") return second.body;
    // MCP-FR-29: never more than one retry per request.
    throw new KerdialError({
      kind: "rate-limited",
      code: second.code,
      retryAfterSeconds: second.seconds,
    });
  }

  async #attempt(
    path: string,
    url: string,
  ): Promise<
    | { readonly kind: "body"; readonly body: unknown }
    | { readonly kind: "retry"; readonly seconds: number; readonly code: string | undefined }
  > {
    const started = performance.now();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#config.token}`,
          Accept: "application/json",
          "User-Agent": this.#userAgent,
        },
        // Any 3xx is an error: the Authorization header never follows a
        // redirect anywhere, same origin or not.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
    } catch (err) {
      const reason = transportReason(err);
      this.#log?.(
        `kerdial-mcp: GET ${path} failed (${reason}) ${Math.round(performance.now() - started)}ms`,
      );
      throw unreachable(reason);
    }
    this.#log?.(
      `kerdial-mcp: GET ${path} ${response.status} ${Math.round(performance.now() - started)}ms`,
    );

    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw unreachable("unexpected redirect; check KERDIAL_URL");
    }
    if (response.ok) return { kind: "body", body: await readJson(response) };

    const problem = await readProblem(response);
    const code = typeof problem["code"] === "string" ? problem["code"] : undefined;
    switch (response.status) {
      case 401:
        throw new KerdialError({ kind: "unauthorized" });
      case 403:
        throw new KerdialError({ kind: "forbidden", code });
      case 404:
        throw new KerdialError({ kind: "not-found", code });
      case 429: {
        const seconds = parseRetryAfter(response.headers.get("retry-after"));
        if (seconds !== undefined && seconds <= MAX_RETRY_AFTER_SECONDS) {
          return { kind: "retry", seconds, code };
        }
        throw new KerdialError({ kind: "rate-limited", code, retryAfterSeconds: seconds });
      }
    }
    if (response.status >= 500) {
      throw unreachable(`HTTP ${response.status}${code === undefined ? "" : ` ${code}`}`);
    }
    throw new KerdialError({
      kind: "rejected",
      status: response.status,
      title: typeof problem["title"] === "string" ? problem["title"] : undefined,
      code,
      params: scalarParams(problem["params"]),
      fields: fieldNames(problem["errors"]),
    });
  }
}

function unreachable(reason: string): KerdialError {
  return new KerdialError({ kind: "unreachable", reason });
}

/** A timeout, or the system error code (`ECONNREFUSED`…) — never the error message, which may quote the URL. */
function transportReason(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timed out";
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = cause?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code)
    ? `network error ${code}`
    : "network error";
}

async function readJson(response: Response): Promise<unknown> {
  const mediaType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === undefined || !JSON_MEDIA_TYPES.has(mediaType)) {
    await discard(response);
    throw unreachable("the response is not JSON");
  }
  const text = await readCapped(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unreachable("the response is not valid JSON");
  }
}

/** An error body, best effort: a 401 is a 401 whether or not its body parses. */
async function readProblem(response: Response): Promise<Readonly<Record<string, unknown>>> {
  try {
    const body = JSON.parse(await readCapped(response)) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch (err) {
    if (err instanceof KerdialError) throw err;
    return {};
  }
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await discard(response);
    throw unreachable("the response is larger than 4 MiB");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw unreachable("the response is larger than 4 MiB");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof KerdialError) throw err;
    throw unreachable(transportReason(err));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw unreachable("the response is not valid UTF-8");
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to recover: the response is being refused anyway.
  }
}

/** Delta-seconds only; an HTTP-date `Retry-After` is reported without a number. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  return String(seconds) === raw.trim() && seconds >= 0 ? seconds : undefined;
}

function scalarParams(raw: unknown): Readonly<Record<string, string | number>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") params[key] = value;
  }
  return params;
}

function fieldNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { field?: unknown }).field === "string"
      ? [(entry as { field: string }).field]
      : [],
  );
}
