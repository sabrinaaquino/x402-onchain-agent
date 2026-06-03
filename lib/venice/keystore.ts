// ─────────────────────────────────────────────────────────────────────────────
// Secure private-key loading.
//
// WORKSHOP SECTION: "Storing the wallet private key safely".
//
// This module demonstrates a layered approach, from least to most protected:
//
//   1. Raw env var (WALLET_PRIVATE_KEY) — convenient, but the key sits in
//      plaintext in your shell/process environment. Fine for a throwaway
//      demo wallet, never for a wallet holding real funds.
//
//   2. Encrypted keystore file (keystore.json) — the key is AES-256-GCM
//      encrypted with a scrypt-derived key from a passphrase. The passphrase
//      lives in the environment (KEYSTORE_PASSPHRASE); the ciphertext lives on
//      disk. Compromising one is not enough. This mirrors how Geth/ethers
//      keystores work (EIP-2335-ish).
//
//   3. (Production, not implemented here) A managed secret store / KMS / HSM:
//      AWS KMS, GCP Secret Manager, HashiCorp Vault, or a hardware signer.
//      The private key never enters your app process at all — you send a
//      payload to the KMS and get back a signature. See README "Going to prod".
//
// The key is only ever read on the server (Node) — it is never sent to the
// browser, and Venice never receives it (x402 signs locally; Crypto RPC only
// ever sees already-signed raw transactions).
// ─────────────────────────────────────────────────────────────────────────────

import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SCRYPT_N = 1 << 15; // 32768 — CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32; // AES-256

export interface EncryptedKeystore {
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  kdfparams: { n: number; r: number; p: number; salt: string; keylen: number };
  iv: string;
  authTag: string;
  ciphertext: string;
}

function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "Invalid private key: expected 64 hex chars (32 bytes), optionally 0x-prefixed.",
    );
  }
  return `0x${hex.toLowerCase()}` as `0x${string}`;
}

/** Encrypt a private key into a keystore object using a passphrase. */
export function encryptPrivateKey(privateKey: string, passphrase: string): EncryptedKeystore {
  const normalized = normalizePrivateKey(privateKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(normalized.slice(2), "hex")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    kdfparams: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("hex"), keylen: KEY_LEN },
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

/** Decrypt a keystore object back into a 0x-prefixed private key. */
export function decryptKeystore(store: EncryptedKeystore, passphrase: string): `0x${string}` {
  if (store.version !== 1 || store.cipher !== "aes-256-gcm" || store.kdf !== "scrypt") {
    throw new Error("Unsupported keystore format.");
  }
  const salt = Buffer.from(store.kdfparams.salt, "hex");
  const derived = scryptSync(passphrase, salt, store.kdfparams.keylen, {
    N: store.kdfparams.n,
    r: store.kdfparams.r,
    p: store.kdfparams.p,
  });

  const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(store.iv, "hex"));
  decipher.setAuthTag(Buffer.from(store.authTag, "hex"));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(store.ciphertext, "hex")),
      decipher.final(),
    ]);
    return normalizePrivateKey(plaintext.toString("hex"));
  } catch {
    throw new Error("Keystore decryption failed — wrong passphrase or corrupted file.");
  }
}

/**
 * Resolve the wallet private key from the most secure source available.
 * Priority: encrypted keystore > raw env var. Returns undefined if neither set
 * (the app then runs in API-key-only mode).
 */
export function loadWalletKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  const { KEYSTORE_PATH, KEYSTORE_PASSPHRASE, WALLET_PRIVATE_KEY } = env;

  if (KEYSTORE_PATH && KEYSTORE_PASSPHRASE) {
    // Lazy require so the browser bundle never pulls in fs.
    const { readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const store = JSON.parse(rf(KEYSTORE_PATH, "utf8")) as EncryptedKeystore;
    return decryptKeystore(store, KEYSTORE_PASSPHRASE);
  }

  if (WALLET_PRIVATE_KEY && WALLET_PRIVATE_KEY.trim().length > 0) {
    return normalizePrivateKey(WALLET_PRIVATE_KEY);
  }

  return undefined;
}
