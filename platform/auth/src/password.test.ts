import { describe, expect, it } from "vitest";
import {
  ARGON2ID_OPTIONS,
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "./password.js";

describe("platform/auth — Argon2id password hashing (T-10)", () => {
  it("hashes with the documented Argon2id parameters (memory 64 MiB, time cost 3, parallelism 1)", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain(`m=${ARGON2ID_OPTIONS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2ID_OPTIONS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2ID_OPTIONS.parallelism}`);
  });

  it("a correct password against a stored hash verifies true", async () => {
    const hash = await hashPassword("s3cret-passphrase");
    await expect(verifyPassword(hash, "s3cret-passphrase")).resolves.toBe(true);
  });

  it("an incorrect password against a stored hash verifies false", async () => {
    const hash = await hashPassword("s3cret-passphrase");
    await expect(verifyPassword(hash, "wrong-passphrase")).resolves.toBe(false);
  });

  it("the stored hash never contains the plaintext password", async () => {
    const password = "does-not-appear-in-hash-output";
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it("hashing the same password twice yields two different hashes (random salt) that both verify", async () => {
    const hashA = await hashPassword("same-password");
    const hashB = await hashPassword("same-password");
    expect(hashA).not.toBe(hashB);
    await expect(verifyPassword(hashA, "same-password")).resolves.toBe(true);
    await expect(verifyPassword(hashB, "same-password")).resolves.toBe(true);
  });

  it("the dummy password hash (used to keep unknown-email timing constant) is a real, verifiable Argon2id hash", async () => {
    const dummyHash = await getDummyPasswordHash();
    expect(dummyHash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(dummyHash, "not-the-dummy-password")).resolves.toBe(false);
  });
});
