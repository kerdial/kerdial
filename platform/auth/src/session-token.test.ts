import { describe, expect, it } from "vitest";
import { hashSessionToken, issueSessionToken } from "./session-token.js";

describe("platform/auth — session tokens (T-10)", () => {
  it("issues a 256-bit (32-byte) token, base64url-encoded", () => {
    const { token } = issueSessionToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("two issued tokens are never equal (CSPRNG, not a fixed/predictable value)", () => {
    const a = issueSessionToken();
    const b = issueSessionToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash.equals(b.tokenHash)).toBe(false);
  });

  it("hashing is deterministic: the same token always hashes to the same value", () => {
    const { token, tokenHash } = issueSessionToken();
    expect(hashSessionToken(token).equals(tokenHash)).toBe(true);
  });

  it("the hash is a 32-byte SHA-256 digest, not a copy or encoding of the token itself", () => {
    const { token, tokenHash } = issueSessionToken();
    expect(tokenHash).toHaveLength(32);
    expect(tokenHash.toString("base64url")).not.toBe(token);
    // A database read of the stored hash cannot reproduce the raw token: SHA-256
    // is one-way, so there is no decoding step back from tokenHash to token.
    expect(tokenHash.toString("hex")).not.toContain(token);
  });
});
