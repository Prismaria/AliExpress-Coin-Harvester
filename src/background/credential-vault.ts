import { CREDENTIAL_KEY_STORAGE_KEY, CREDENTIALS_STORAGE_KEY } from "../shared/constants";
import type { CredentialStatus } from "../shared/types";

export type AliExpressCredentials = {
  username: string;
  password: string;
};

export type CredentialEnvelope = {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
};

export type CredentialStorage = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BITS = 128;
const PASSWORD_MAX_LENGTH = 40;
const CREDENTIALS_AAD = new TextEncoder().encode("ali-coin-harvester.credentials.v1");

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new CredentialVaultError("Saved credentials could not be read. Clear them and enter them again.");
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CredentialVaultError("Saved credentials could not be read. Clear them and enter them again.");
  }
}

function isEnvelope(value: unknown): value is CredentialEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CredentialEnvelope>;
  return candidate.version === 1 && candidate.algorithm === "AES-GCM" &&
    typeof candidate.iv === "string" && typeof candidate.ciphertext === "string";
}

function validateCredentials(credentials: AliExpressCredentials): AliExpressCredentials {
  if (!credentials || typeof credentials.username !== "string" || typeof credentials.password !== "string") {
    throw new CredentialVaultError("Enter both your AliExpress account and password.");
  }
  const username = credentials.username.trim();
  if (!username || username.length > 320) throw new CredentialVaultError("Enter a valid AliExpress email or account name.");
  if (!credentials.password.length || credentials.password.length > PASSWORD_MAX_LENGTH) {
    throw new CredentialVaultError(`Enter a password up to ${PASSWORD_MAX_LENGTH} characters long.`);
  }
  return { username, password: credentials.password };
}

export function createCredentialVault(storage: CredentialStorage, cryptoProvider: Crypto = globalThis.crypto) {
  async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
    if (rawKey.byteLength !== KEY_BYTES) throw new CredentialVaultError("Saved credentials could not be read. Clear them and enter them again.");
    return cryptoProvider.subtle.importKey("raw", toArrayBuffer(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function decryptEnvelope(envelope: unknown, rawKey: unknown): Promise<AliExpressCredentials> {
    if (!isEnvelope(envelope)) throw new CredentialVaultError("Saved credentials could not be read. Clear them and enter them again.");
    let keyBytes: Uint8Array | undefined;
    let plaintextBytes: Uint8Array | undefined;
    try {
      keyBytes = decodeBase64(rawKey);
      const iv = decodeBase64(envelope.iv);
      const ciphertext = decodeBase64(envelope.ciphertext);
      if (iv.byteLength !== IV_BYTES || ciphertext.byteLength <= AUTH_TAG_BITS / 8) {
        throw new CredentialVaultError("Saved credentials could not be read. Clear them and enter them again.");
      }
      const key = await importKey(keyBytes);
      const plaintext = await cryptoProvider.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(CREDENTIALS_AAD), tagLength: AUTH_TAG_BITS },
        key,
        toArrayBuffer(ciphertext)
      );
      plaintextBytes = new Uint8Array(plaintext);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintextBytes));
      if (!value || typeof value !== "object") throw new Error("Invalid credential payload");
      const candidate = value as Partial<AliExpressCredentials>;
      if (typeof candidate.username !== "string" || typeof candidate.password !== "string" || !candidate.username || !candidate.password) {
        throw new Error("Invalid credential payload");
      }
      return { username: candidate.username, password: candidate.password };
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError("Saved credentials could not be decrypted. Clear them and enter them again.");
    } finally {
      keyBytes?.fill(0);
      plaintextBytes?.fill(0);
    }
  }

  async function getCredentials(): Promise<AliExpressCredentials | undefined> {
    let stored: Record<string, unknown>;
    try {
      stored = await storage.get([CREDENTIALS_STORAGE_KEY, CREDENTIAL_KEY_STORAGE_KEY]);
    } catch {
      throw new CredentialVaultError("Credential storage is unavailable.");
    }
    const envelope = stored[CREDENTIALS_STORAGE_KEY];
    if (envelope === undefined) return undefined;
    return decryptEnvelope(envelope, stored[CREDENTIAL_KEY_STORAGE_KEY]);
  }

  return {
    async getStatus(): Promise<CredentialStatus> {
      const credentials = await getCredentials();
      if (!credentials) return { saved: false };
      const status = { saved: true, username: credentials.username };
      credentials.username = "";
      credentials.password = "";
      return status;
    },

    getCredentials,

    async save(input: AliExpressCredentials): Promise<CredentialStatus> {
      const credentials = validateCredentials(input);
      const savedStatus: CredentialStatus = { saved: true, username: credentials.username };
      let rawKey: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      try {
        let stored: Record<string, unknown>;
        try {
          stored = await storage.get([CREDENTIALS_STORAGE_KEY, CREDENTIAL_KEY_STORAGE_KEY]);
        } catch {
          throw new CredentialVaultError("Credential storage is unavailable.");
        }

        const existingEnvelope = stored[CREDENTIALS_STORAGE_KEY];
        if (existingEnvelope !== undefined) {
          // Verify the current record before replacing it. A damaged/missing key must not
          // silently turn an attempted update into permanent credential loss.
          const previousCredentials = await decryptEnvelope(existingEnvelope, stored[CREDENTIAL_KEY_STORAGE_KEY]);
          previousCredentials.username = "";
          previousCredentials.password = "";
          rawKey = decodeBase64(stored[CREDENTIAL_KEY_STORAGE_KEY]);
        } else {
          rawKey = cryptoProvider.getRandomValues(new Uint8Array(KEY_BYTES));
        }

        const key = await importKey(rawKey);
        const iv = cryptoProvider.getRandomValues(new Uint8Array(IV_BYTES));
        plaintext = new TextEncoder().encode(JSON.stringify(credentials));
        const ciphertext = await cryptoProvider.subtle.encrypt(
          { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(CREDENTIALS_AAD), tagLength: AUTH_TAG_BITS },
          key,
          toArrayBuffer(plaintext)
        );
        const envelope: CredentialEnvelope = {
          version: 1,
          algorithm: "AES-GCM",
          iv: encodeBase64(iv),
          ciphertext: encodeBase64(new Uint8Array(ciphertext))
        };
        await storage.set({
          [CREDENTIAL_KEY_STORAGE_KEY]: encodeBase64(rawKey),
          [CREDENTIALS_STORAGE_KEY]: envelope
        });
      } catch (error) {
        if (error instanceof CredentialVaultError) throw error;
        throw new CredentialVaultError("Credentials could not be encrypted or saved.");
      } finally {
        rawKey?.fill(0);
        plaintext?.fill(0);
        credentials.username = "";
        credentials.password = "";
      }

      return savedStatus;
    },

    async clear(): Promise<void> {
      try {
        await storage.remove([CREDENTIALS_STORAGE_KEY, CREDENTIAL_KEY_STORAGE_KEY]);
      } catch {
        throw new CredentialVaultError("Saved credentials could not be cleared.");
      }
    }
  };
}
