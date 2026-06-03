#!/usr/bin/env node
// Top up the agent wallet's Venice x402 balance with USDC on Base.
//
// Holding USDC in the wallet is NOT the same as having spendable Venice balance.
// This script performs the x402 top-up handshake: it signs a USDC transfer
// authorization to Venice's receiver and credits the wallet's prepaid balance.
//
//   node --env-file=.env scripts/topup.mjs [amountUsd]
//
// Requires WALLET_PRIVATE_KEY (or keystore) to hold >= amountUsd of USDC on Base,
// plus a little ETH on Base for gas. Default amount = 5 (the minimum).

import { createPaymentHeader } from "x402/client";
import { privateKeyToAccount } from "viem/accounts";
import { Wallet } from "ethers";

const BASE = process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const KEY = process.env.WALLET_PRIVATE_KEY;
const AMOUNT_USD = Number(process.argv[2] || 5);

if (!KEY) {
  console.error("Set WALLET_PRIVATE_KEY in .env first.");
  process.exit(1);
}

const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
console.log(`\n▶ x402 top-up`);
console.log(`  wallet : ${account.address}`);
console.log(`  amount : $${AMOUNT_USD} USDC on Base\n`);

// Step 1: ask /x402/top-up with NO payment header → get payment requirements (402).
console.log("1) Requesting payment requirements…");
const reqRes = await fetch(`${BASE}/x402/top-up`, { method: "POST" });
if (reqRes.status !== 402) {
  console.log(`   Unexpected status ${reqRes.status}: ${await reqRes.text()}`);
  process.exit(1);
}

// The accepted payment options are in the PAYMENT-REQUIRED header (or body).
let accepts;
const prHeader = reqRes.headers.get("PAYMENT-REQUIRED") || reqRes.headers.get("payment-required");
if (prHeader) {
  try {
    accepts = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")).accepts;
  } catch {
    accepts = JSON.parse(prHeader).accepts;
  }
} else {
  const body = await reqRes.json().catch(() => ({}));
  accepts = body.accepts;
}

if (!accepts || accepts.length === 0) {
  console.log("   No payment options returned. Raw:", prHeader || "(none)");
  process.exit(1);
}

// Pick the Base option.
const base = accepts.find((a) => a.network === "base" || a.network === "eip155:8453") || accepts[0];
console.log("   payTo  :", base.payTo, "| asset:", base.asset, "| network:", base.network);

// Step 2: build a signed X-402-Payment header for the chosen amount.
console.log("2) Signing USDC transfer authorization…");
const amountBaseUnits = String(Math.round(AMOUNT_USD * 1e6)); // USDC has 6 decimals
const paymentHeader = await createPaymentHeader(account, 2, {
  scheme: base.scheme || "exact",
  network: "base",
  maxAmountRequired: amountBaseUnits,
  resource: `${BASE}/x402/top-up`,
  description: "Venice x402 top-up",
  mimeType: "application/json",
  payTo: base.payTo,
  maxTimeoutSeconds: 300,
  asset: base.asset,
  extra: base.extra || { name: "USD Coin", version: "2" },
});

// Step 3: resubmit with the signed payment header.
console.log("3) Submitting payment…");
const payRes = await fetch(`${BASE}/x402/top-up`, {
  method: "POST",
  headers: { "X-402-Payment": paymentHeader },
});
console.log("   status:", payRes.status);
console.log("   body  :", await payRes.text());

if (payRes.ok) {
  console.log("\n✅ Top-up submitted. Re-run the smoke test to confirm balance.\n");
} else {
  console.log("\n✗ Top-up failed. Check USDC balance + ETH gas on Base, then retry.\n");
}
