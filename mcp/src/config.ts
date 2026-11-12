/**
 * Start-up configuration, read from the environment (and `--url` on the
 * command line) once, before the server speaks a single protocol frame.
 *
 * The token has **no** command-line path: argv shows in process listings.
 * Every refusal names the variable and the rule it broke and never echoes a
 * value — not the token, and not the URL either, which a user may have
 * pasted with credentials in it.
 */

/** `kdl_pat_` + 32 hex + 43 base64url — the shape the server issues (ADR-0019). */
const TOKEN_SHAPE = /^kdl_pat_[0-9a-f]{32}[A-Za-z0-9_-]{43}$/;

const DEFAULT_TIMEOUT_MS = 35_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export interface KerdialConfig {
  /** The instance's base URL without a trailing slash; a path prefix is kept. The client appends `/api/v1`. */
  readonly baseUrl: string;
  /** The host (and port) of {@link KerdialConfig.baseUrl} — the only part of it an error message names. */
  readonly host: string;
  readonly token: string;
  /** MCP-L5: transaction notes and references are relayed only when this is set. */
  readonly includeNotes: boolean;
  readonly timeoutMs: number;
  /** Request diagnostics on stderr (method, path without query, status, duration). */
  readonly debug: boolean;
}

/** A refused configuration. Its message is safe to print: it never contains a configured value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env, argv: readonly string[] = []): KerdialConfig {
  const allowInsecureHttp = readFlag(env, "KERDIAL_MCP_ALLOW_INSECURE_HTTP");
  const url = parseBaseUrl(readUrlArgument(argv) ?? requireValue(env, "KERDIAL_URL"));
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowInsecureHttp) {
    throw new ConfigError(
      "KERDIAL_URL uses plain http:// to a non-loopback host; use https://, or set KERDIAL_MCP_ALLOW_INSECURE_HTTP=1 to accept that the token crosses the network unencrypted",
    );
  }

  const token = env["KERDIAL_TOKEN"];
  if (token === undefined || token === "") {
    throw new ConfigError(
      "KERDIAL_TOKEN is not set; create a token in Kerdial and pass it in this environment variable",
    );
  }
  if (!TOKEN_SHAPE.test(token)) {
    throw new ConfigError("KERDIAL_TOKEN is not a Kerdial access token (kdl_pat_…)");
  }

  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    host: url.host,
    token,
    includeNotes: readFlag(env, "KERDIAL_MCP_INCLUDE_NOTES"),
    timeoutMs: readTimeout(env),
    debug: readFlag(env, "KERDIAL_MCP_DEBUG"),
  };
}

function readUrlArgument(argv: readonly string[]): string | undefined {
  let url: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--url") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ConfigError("--url needs a value (the instance's base URL)");
      }
      url = next;
      i += 1;
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (arg === "--token" || arg.startsWith("--token=")) {
      throw new ConfigError(
        "the token is not accepted on the command line (it would show in process listings); set KERDIAL_TOKEN",
      );
    } else {
      // The argument itself is not echoed: it may be a pasted secret.
      throw new ConfigError("unexpected command-line argument; the only option is --url <url>");
    }
  }
  return url;
}

function requireValue(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(
      `${name} is not set (the instance's base URL, e.g. https://kerdial.example)`,
    );
  }
  return value;
}

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("KERDIAL_URL is not an absolute URL (https://…)");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("KERDIAL_URL must start with https:// (or http:// for a loopback host)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("KERDIAL_URL must not contain a user name or password");
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new ConfigError("KERDIAL_URL must not contain a query string or a fragment");
  }
  return url;
}

/** Loopback = `localhost`, `127.0.0.0/8`, `[::1]`. `URL` has already normalised the host. */
function isLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function readFlag(env: Env, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new ConfigError(`${name} must be 1 or 0`);
}

function readTimeout(env: Env): number {
  const raw = env["KERDIAL_MCP_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (String(parsed) !== raw.trim() || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `KERDIAL_MCP_TIMEOUT_MS must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return parsed;
}
