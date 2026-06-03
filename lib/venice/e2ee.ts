// ─────────────────────────────────────────────────────────────────────────────
// End-to-End Encryption for Venice chat completions.
//
// WORKSHOP SECTION: "Venice E2EE" + "all privately analysed by our E2EE models".
//
// Protocol (per Venice docs):
//   • secp256k1 ECDH for key exchange
//   • HKDF-SHA256 (info = "ecdsa_encryption") for key derivation
//   • AES-256-GCM for symmetric encryption
//   • TEE attestation to verify the model runs in a genuine enclave
//
// Flow:
//   1. Generate an ephemeral secp256k1 key pair (client session key).
//   2. Fetch /tee/attestation?model=...&nonce=... (nonce = 32 bytes / 64 hex).
//   3. Verify attestation: verified === true AND nonce matches.
//   4. Encrypt each user/system message: ECDH(model pubkey) -> HKDF -> AES-GCM.
//      Wire format per message = ephemeralPub(65) || nonce(12) || ciphertext+tag, hex.
//   5. POST /chat/completions with stream:true and the X-Venice-TEE-* headers.
//   6. Decrypt each streamed chunk with the client private key.
//
// Venice relays only ciphertext; only the attested TEE can decrypt the prompt.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import elliptic from "elliptic";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ChatMessage } from "./types";

const EC = elliptic.ec;
const HKDF_INFO = new TextEncoder().encode("ecdsa_encryption");

export interface AttestationContext {
  clientPublicKeyHex: string;
  clientPrivateKey: Buffer;
  modelPublicKey: string;
  signingAddress?: string;
  teeProvider?: string;
  verified: boolean;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isHexEncrypted(s: string): boolean {
  // Minimum: ephemeralPub(65) + nonce(12) + tag(16) = 93 bytes = 186 hex chars.
  return s.length >= 186 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Step 1-3: generate an ephemeral key pair, fetch attestation, verify it.
 * Throws if attestation fails or nonce mismatches (possible replay).
 */
export async function fetchAndVerifyAttestation(
  baseUrl: string,
  modelId: string,
  authHeaders: Record<string, string>,
): Promise<AttestationContext> {
  const ec = new EC("secp256k1");
  const keyPair = ec.genKeyPair();
  const clientPublicKeyHex = keyPair.getPublic("hex");
  const clientPrivateKey = Buffer.from(keyPair.getPrivate().toArray("be", 32));

  // 32-byte nonce (64 hex). 16 bytes is a common mistake and some providers reject it.
  const clientNonce = crypto.randomBytes(32).toString("hex");

  const url = `${baseUrl}/tee/attestation?model=${encodeURIComponent(modelId)}&nonce=${clientNonce}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Attestation fetch failed: ${res.status} ${await res.text()}`);
  }
  const attestation = (await res.json()) as {
    verified?: boolean;
    nonce?: string;
    signing_key?: string;
    signing_public_key?: string;
    signing_address?: string;
    tee_provider?: string;
  };

  if (attestation.verified !== true) {
    throw new Error("TEE attestation verification failed on server.");
  }
  if (attestation.nonce !== clientNonce) {
    throw new Error("Attestation nonce mismatch — possible replay attack.");
  }

  const modelPublicKey = attestation.signing_key || attestation.signing_public_key;
  if (!modelPublicKey) {
    throw new Error("No signing key in attestation response.");
  }

  return {
    clientPublicKeyHex,
    clientPrivateKey,
    modelPublicKey,
    signingAddress: attestation.signing_address,
    teeProvider: attestation.tee_provider,
    verified: true,
  };
}

/** Step 4: encrypt a single plaintext message for the model's public key. */
function encryptMessage(plaintext: string, modelPublicKeyHex: string): string {
  const ec = new EC("secp256k1");

  let normalizedKey = modelPublicKeyHex;
  if (!normalizedKey.startsWith("04") && normalizedKey.length === 128) {
    normalizedKey = "04" + normalizedKey;
  }
  const modelPublicKey = ec.keyFromPublic(normalizedKey, "hex");

  const ephemeralKeyPair = ec.genKeyPair();
  const sharedSecret = ephemeralKeyPair.derive(modelPublicKey.getPublic());
  const sharedSecretBytes = new Uint8Array(sharedSecret.toArray("be", 32));
  const aesKey = hkdf(sha256, sharedSecretBytes, undefined, HKDF_INFO, 32);

  const nonce = crypto.randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext));

  const ephemeralPublic = new Uint8Array(ephemeralKeyPair.getPublic(false, "array"));
  const result = new Uint8Array(65 + 12 + encrypted.length);
  result.set(ephemeralPublic, 0);
  result.set(nonce, 65);
  result.set(encrypted, 65 + 12);

  return Buffer.from(result).toString("hex");
}

export function encryptMessagesForE2EE(
  messages: ChatMessage[],
  modelPublicKey: string,
): ChatMessage[] {
  // When E2EE headers are present, EVERY message's content must be hex-encrypted
  // (the TEE decrypts them all). This includes prior `assistant` turns in a
  // multi-turn chat — leaving any role as plaintext triggers a Venice
  // "Encrypted field is not valid hex" 400. We encrypt all string content.
  return messages.map((msg) =>
    typeof msg.content === "string" && msg.content.length > 0
      ? { ...msg, content: encryptMessage(msg.content, modelPublicKey) }
      : msg,
  );
}

/** Step 6: decrypt one streamed hex chunk with the client's private key. */
function decryptChunk(ciphertextHex: string, clientPrivateKey: Buffer): string {
  const raw = hexToBytes(ciphertextHex);
  const serverEphemeralPubKey = raw.slice(0, 65);
  const nonce = raw.slice(65, 65 + 12);
  const ciphertext = raw.slice(65 + 12);

  const ec = new EC("secp256k1");
  const clientKey = ec.keyFromPrivate(clientPrivateKey);
  const serverKey = ec.keyFromPublic(Buffer.from(serverEphemeralPubKey));
  const sharedSecret = clientKey.derive(serverKey.getPublic());
  const aesKey = hkdf(sha256, new Uint8Array(sharedSecret.toArray("be", 32)), undefined, HKDF_INFO, 32);

  const cipher = gcm(aesKey, nonce);
  return new TextDecoder().decode(cipher.decrypt(ciphertext));
}

/**
 * Full E2EE chat completion. Encrypts the prompt, streams the response, and
 * returns the fully-decrypted text. `onToken` lets the caller stream tokens out.
 */
export async function e2eeChatCompletion(opts: {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  authHeaders: Record<string, string>;
  ctx: AttestationContext;
  onToken?: (t: string) => void;
}): Promise<string> {
  const { baseUrl, model, messages, authHeaders, ctx, onToken } = opts;

  const encryptedMessages = encryptMessagesForE2EE(messages, ctx.modelPublicKey);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "X-Venice-TEE-Client-Pub-Key": ctx.clientPublicKeyHex,
      "X-Venice-TEE-Model-Pub-Key": ctx.modelPublicKey,
      "X-Venice-TEE-Signing-Algo": "ecdsa",
    },
    body: JSON.stringify({ model, messages: encryptedMessages, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`E2EE chat request failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep partial line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]" || data.length === 0) continue;

      try {
        const chunk = JSON.parse(data);
        const content: string | undefined = chunk?.choices?.[0]?.delta?.content;
        if (!content) continue;
        const piece = isHexEncrypted(content) ? decryptChunk(content, ctx.clientPrivateKey) : content;
        full += piece;
        onToken?.(piece);
      } catch {
        // skip malformed/partial chunks
      }
    }
  }

  // Best-effort: zero the private key material after use.
  ctx.clientPrivateKey.fill(0);

  return full;
}
