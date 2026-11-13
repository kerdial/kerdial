import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { TEST_TOKEN } from "./test-harness.js";

/** MCP-AC-21 (configuration half), MCP-FR-25, MCP-FR-26. */

function refusal(env: Record<string, string>, argv: string[] = []): ConfigError {
  try {
    loadConfig(env, argv);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("MCP-AC-21 — a missing token is refused with the variable named", () => {
    const error = refusal({ KERDIAL_URL: "https://kerdial.example" });
    expect(error.message).toContain("KERDIAL_TOKEN");
  });

  it("MCP-FR-25 — a malformed token is refused without echoing its value", () => {
    const pasted = `${TEST_TOKEN}-trailing-garbage`;
    const error = refusal({ KERDIAL_URL: "https://kerdial.example", KERDIAL_TOKEN: pasted });
    expect(error.message).toContain("KERDIAL_TOKEN");
    expect(error.message).not.toContain(pasted);
    expect(error.message).not.toContain(TEST_TOKEN);
  });

  it("MCP-FR-25 — the token has no command-line path, and an unexpected argument is not echoed", () => {
    const env = { KERDIAL_URL: "https://kerdial.example", KERDIAL_TOKEN: TEST_TOKEN };
    expect(refusal(env, ["--token", TEST_TOKEN]).message).toContain("KERDIAL_TOKEN");
    expect(refusal(env, ["--token", TEST_TOKEN]).message).not.toContain(TEST_TOKEN);
    expect(refusal(env, [TEST_TOKEN]).message).not.toContain(TEST_TOKEN);
  });

  it("MCP-AC-21 — plain http:// to a non-loopback host is refused unless the override is set", () => {
    const env = { KERDIAL_URL: "http://nas.example:3000", KERDIAL_TOKEN: TEST_TOKEN };
    expect(refusal(env).message).toContain("KERDIAL_MCP_ALLOW_INSECURE_HTTP");
    expect(loadConfig({ ...env, KERDIAL_MCP_ALLOW_INSECURE_HTTP: "1" }).baseUrl).toBe(
      "http://nas.example:3000",
    );
    for (const loopback of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(loadConfig({ KERDIAL_URL: loopback, KERDIAL_TOKEN: TEST_TOKEN }).baseUrl).toBe(
        loopback,
      );
    }
  });

  it("MCP-FR-25 — --url wins over KERDIAL_URL, a path prefix is kept, credentials and queries are refused", () => {
    const config = loadConfig(
      { KERDIAL_URL: "https://ignored.example", KERDIAL_TOKEN: TEST_TOKEN },
      ["--url", "https://kerdial.example/prefix/"],
    );
    expect(config.baseUrl).toBe("https://kerdial.example/prefix");
    expect(config.host).toBe("kerdial.example");
    expect(config.includeNotes).toBe(false);
    expect(config.timeoutMs).toBe(35_000);

    const withPassword = "https://user:hunter2@kerdial.example";
    const error = refusal({ KERDIAL_URL: withPassword, KERDIAL_TOKEN: TEST_TOKEN });
    expect(error.message).not.toContain("hunter2");
    expect(
      refusal({ KERDIAL_URL: "https://kerdial.example/?a=b", KERDIAL_TOKEN: TEST_TOKEN }).message,
    ).toContain("query");
    expect(
      refusal({
        KERDIAL_URL: "https://kerdial.example",
        KERDIAL_TOKEN: TEST_TOKEN,
        KERDIAL_MCP_TIMEOUT_MS: "500",
      }).message,
    ).toContain("KERDIAL_MCP_TIMEOUT_MS");
  });
});
