#!/usr/bin/env node
// Encrypt a private key into keystore.json using a passphrase (scrypt + AES-256-GCM).
// This is the "store the key safely" demo. The ciphertext goes on disk; the
// passphrase goes in the environment. Neither alone is enough to sign.
//
//   node scripts/encrypt-key.mjs <privateKey> <passphrase> [outPath]
//
// Then in .env.local:
//   KEYSTORE_PATH=./keystore.json
//   KEYSTORE_PASSPHRASE=<passphrase>
//   VENICE_AUTH_MODE=x402

import { writeFileSync } from "node:fs";
import { scryptSync, createCipheriv, randomBytes } from "node:crypto";

const [, , privateKey, passphrase, outPath = "./keystore.json"] = process.argv;

if (!privateKey || !passphrase) {
  console.error("Usage: node scripts/encrypt-key.mjs <privateKey> <passphrase> [outPath]");
  process.exit(1);
}

const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
  console.error("Invalid private key: expected 64 hex chars (32 bytes), optionally 0x-prefixed.");
  process.exit(1);
}

const salt = randomBytes(16);
const iv = randomBytes(12);
const derived = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1 });

const cipher = createCipheriv("aes-256-gcm", derived, iv);
const ciphertext = Buffer.concat([cipher.update(Buffer.from(hex, "hex")), cipher.final()]);
const authTag = cipher.getAuthTag();

const store = {
  version: 1,
  cipher: "aes-256-gcm",
  kdf: "scrypt",
  kdfparams: { n: 1 << 15, r: 8, p: 1, salt: salt.toString("hex"), keylen: 32 },
  iv: iv.toString("hex"),
  authTag: authTag.toString("hex"),
  ciphertext: ciphertext.toString("hex"),
};

writeFileSync(outPath, JSON.stringify(store, null, 2));
console.log(`\n  Wrote encrypted keystore to ${outPath}`);
console.log("  Set in .env.local:");
console.log(`    KEYSTORE_PATH=${outPath}`);
console.log("    KEYSTORE_PASSPHRASE=<your passphrase>");
console.log("\n  keystore.json is gitignored. The raw key is never written to disk in plaintext.\n");
