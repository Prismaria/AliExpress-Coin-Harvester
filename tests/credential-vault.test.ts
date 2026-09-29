import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_KEY_STORAGE_KEY, CREDENTIALS_STORAGE_KEY } from "../src/shared/constants";
import { createCredentialVault, type CredentialStorage } from "../src/background/credential-vault";

function memoryStorage(): CredentialStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(keys) {
      const names = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(names.filter((key) => values.has(key)).map((key) => [key, values.get(key)]));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) values.delete(key);
    }
  };
}

function makeVault(storage: CredentialStorage) {
  return createCredentialVault(storage, webcrypto as unknown as Crypto);
}

describe("local credential vault", () => {
  it("encrypts credentials locally and decrypts them for the authorized caller", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);
    const saved = await vault.save({ username: "account@example.test", password: "a secret 🔐" });
    const key = storage.values.get(CREDENTIAL_KEY_STORAGE_KEY) as string;
    const envelope = storage.values.get(CREDENTIALS_STORAGE_KEY) as { ciphertext: string; iv: string };

    expect(saved).toEqual({ saved: true, username: "account@example.test" });
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(envelope.ciphertext).not.toContain("account@example.test");
    expect(envelope.ciphertext).not.toContain("a secret");
    await expect(vault.getCredentials()).resolves.toEqual({ username: "account@example.test", password: "a secret 🔐" });
    await expect(vault.getStatus()).resolves.toEqual({ saved: true, username: "account@example.test" });
  });

  it("uses a fresh IV and ciphertext for every save", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);
    await vault.save({ username: "account@example.test", password: "same password" });
    const first = storage.values.get(CREDENTIALS_STORAGE_KEY) as { iv: string; ciphertext: string };
    await vault.save({ username: "account@example.test", password: "same password" });
    const second = storage.values.get(CREDENTIALS_STORAGE_KEY) as { iv: string; ciphertext: string };

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("rejects passwords longer than the AliExpress sign-in field accepts", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);

    await expect(vault.save({ username: "account@example.test", password: "x".repeat(41) })).rejects.toThrow("up to 40 characters");
    expect(storage.values.size).toBe(0);
  });

  it("rejects tampered ciphertext without returning credentials", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);
    await vault.save({ username: "account@example.test", password: "password" });
    const envelope = storage.values.get(CREDENTIALS_STORAGE_KEY) as { ciphertext: string; iv: string; version: 1; algorithm: "AES-GCM" };
    const first = envelope.ciphertext[0] === "A" ? "B" : "A";
    storage.values.set(CREDENTIALS_STORAGE_KEY, { ...envelope, ciphertext: `${first}${envelope.ciphertext.slice(1)}` });

    await expect(vault.getCredentials()).rejects.toThrow("Saved credentials could not be decrypted");
  });

  it("does not replace an existing envelope when its key is missing", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);
    await vault.save({ username: "account@example.test", password: "old password" });
    const original = storage.values.get(CREDENTIALS_STORAGE_KEY);
    storage.values.delete(CREDENTIAL_KEY_STORAGE_KEY);

    await expect(vault.save({ username: "other@example.test", password: "new password" })).rejects.toThrow("Saved credentials could not be read");
    expect(storage.values.get(CREDENTIALS_STORAGE_KEY)).toBe(original);
  });

  it("removes both the encrypted record and key when cleared", async () => {
    const storage = memoryStorage();
    const vault = makeVault(storage);
    await vault.save({ username: "account@example.test", password: "password" });
    await vault.clear();

    expect(storage.values.has(CREDENTIALS_STORAGE_KEY)).toBe(false);
    expect(storage.values.has(CREDENTIAL_KEY_STORAGE_KEY)).toBe(false);
    await expect(vault.getStatus()).resolves.toEqual({ saved: false });
  });
});
