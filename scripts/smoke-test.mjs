#!/usr/bin/env node
// Quick end-to-end smoke test you can run before the workshop to confirm
// credentials + connectivity, without booting the UI.
//
// x402-only (matches the app): inference, Crypto RPC, and images all pay with
// the wallet via x402. No API key anywhere.
//
//   1. cp .env.example .env  (set WALLET_PRIVATE_KEY)
//   2. node --env-file=.env scripts/smoke-test.mjs [address] [network]
//
// Node 22 supports --env-file natively, so no dotenv dependency is needed.

import crypto from "node:crypto";
import { Wallet } from "ethers";
import { SiweMessage, generateNonce } from "siwe";

const BASE = process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const WALLET_KEY = process.env.WALLET_PRIVATE_KEY;
const ADDRESS = process.argv[2] || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = process.argv[3] || process.env.DEFAULT_NETWORK || "base-mainnet";

if (!WALLET_KEY) {
  console.error("Set WALLET_PRIVATE_KEY in .env — this agent uses x402 wallet auth only.");
  process.exit(1);
}

const wallet = new Wallet(WALLET_KEY);
// Everything (RPC + inference + images) authenticates via x402.
const rpcHeaders = (uri) => siwx(uri).then((h) => ({ "X-Sign-In-With-X": h }));
const inferHeaders = (uri) => siwx(uri).then((h) => ({ "X-Sign-In-With-X": h }));

// Build a fresh X-Sign-In-With-X header for a given resource URL.
async function siwx(resourceUrl) {
  const now = new Date();
  const siwe = new SiweMessage({
    domain: "api.venice.ai",
    address: wallet.address,
    statement: "Sign in to Venice AI",
    uri: resourceUrl,
    version: "1",
    chainId: 8453,
    nonce: generateNonce(),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  });
  const message = siwe.prepareMessage();
  const signature = await wallet.signMessage(message);
  return Buffer.from(
    JSON.stringify({ address: wallet.address, message, signature, timestamp: now.getTime(), chainId: 8453 }),
    "utf8",
  ).toString("base64");
}

async function main() {
  console.log(`\n▶ Venice smoke test`);
  console.log(`  base      : ${BASE}`);
  console.log(`  wallet    : ${wallet ? wallet.address : "(none)"}`);
  console.log(`  auth      : x402 (wallet) for inference + RPC + images`);
  console.log(`  network   : ${NETWORK}`);
  console.log(`  address   : ${ADDRESS}\n`);

  // 0. Wallet balance — only meaningful if x402 is configured.
  if (wallet) {
    console.log("0) Checking x402 balance…");
    const balRes = await fetch(`${BASE}/x402/balance/${wallet.address}`, {
      headers: { "X-Sign-In-With-X": await siwx(`${BASE}/x402/balance`) },
    });
    const balJson = await balRes.json();
    const bal = balJson.data ?? balJson; // Venice wraps as { success, data }
    console.log("   canConsume:", bal.canConsume, "| balanceUsd:", bal.balanceUsd, "| diemUsd:", bal.diemBalanceUsd);
    console.log("");
  }

  // 1. Crypto RPC — block number + balance in one batch (paid via x402).
  console.log("1) Crypto RPC batch (eth_blockNumber + eth_getBalance)…");
  const rpcRes = await fetch(`${BASE}/crypto/rpc/${NETWORK}`, {
    method: "POST",
    headers: { ...(await rpcHeaders(`${BASE}/crypto/rpc/${NETWORK}`)), "Content-Type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 },
      { jsonrpc: "2.0", method: "eth_getBalance", params: [ADDRESS, "latest"], id: 2 },
    ]),
  });
  console.log("   status:", rpcRes.status, "| cost USD:", rpcRes.headers.get("X-Venice-RPC-Cost-USD"));
  if (rpcRes.ok) {
    const rpc = await rpcRes.json();
    console.log("   block :", BigInt(rpc.find((r) => r.id === 1)?.result ?? "0x0").toString());
    console.log("   wei   :", BigInt(rpc.find((r) => r.id === 2)?.result ?? "0x0").toString());
  } else {
    console.log("   body  :", await rpcRes.text());
  }
  console.log("");

  // 2. Fetch attestation for the configured E2EE model (inference auth = x402).
  const model = process.env.E2EE_MODEL || "e2ee-qwen3-5-122b-a10b";
  console.log(`2) Fetching TEE attestation for ${model}…`);
  const nonce = crypto.randomBytes(32).toString("hex");
  const attRes = await fetch(`${BASE}/tee/attestation?model=${encodeURIComponent(model)}&nonce=${nonce}`, {
    headers: await inferHeaders(`${BASE}/tee/attestation`),
  });
  if (attRes.ok) {
    const att = await attRes.json();
    console.log("   verified:", att.verified, "| provider:", att.tee_provider, "| signer:", att.signing_address);
  } else {
    console.log("   status:", attRes.status, "| body:", await attRes.text());
  }
  console.log("");

  console.log("✅ Smoke test complete. With a funded wallet, all steps return data.\n");
}

main().catch((e) => {
  console.error("✗ Smoke test failed:", e.message);
  process.exit(1);
});
