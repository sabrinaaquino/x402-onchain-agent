// ─────────────────────────────────────────────────────────────────────────────
// x402 wallet authentication for Venice.
//
// WORKSHOP SECTION: "Venice x402 intro" + "Inference powered by x402".
//
// x402 lets us call Venice's paid routes (chat, crypto RPC, images, ...) by
// signing a Sign-In-With-X (EIP-4361 / SIWE on Base) message with a wallet,
// instead of presenting an API key. Venice debits a prepaid USDC balance
// (or DIEM, if the wallet is linked to a staking account).
//
// We build a fresh `X-Sign-In-With-X` header per request flow (fresh nonce +
// timestamp), exactly as the x402 guide describes. The private key never
// leaves this process.
//
// NOTE: This file deliberately implements the *header construction* by hand so
// the workshop can show what's under the hood. In production you'd typically
// use the official `venice-x402-client` SDK, which also handles top-ups and
// balance tracking from the `X-Balance-Remaining` response header.
// ─────────────────────────────────────────────────────────────────────────────

import { Wallet } from "ethers";
import { SiweMessage, generateNonce } from "siwe";

const BASE_CHAIN_ID = 8453;

/**
 * Build a Base64-encoded X-Sign-In-With-X header for a given Venice resource URL.
 * Each call signs a fresh SIWE message valid for 5 minutes.
 */
export async function buildSiwxHeader(
  privateKey: `0x${string}`,
  resourceUrl: string,
): Promise<{ header: string; address: string }> {
  const wallet = new Wallet(privateKey);
  const now = new Date();

  const siwe = new SiweMessage({
    domain: "api.venice.ai",
    address: wallet.address,
    statement: "Sign in to Venice AI",
    uri: resourceUrl,
    version: "1",
    chainId: BASE_CHAIN_ID,
    nonce: generateNonce(),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  });

  const message = siwe.prepareMessage();
  const signature = await wallet.signMessage(message);

  const header = Buffer.from(
    JSON.stringify({
      address: wallet.address,
      message,
      signature,
      timestamp: now.getTime(),
      chainId: BASE_CHAIN_ID,
    }),
    "utf8",
  ).toString("base64");

  return { header, address: wallet.address };
}

/** Check spendable balance for a wallet (does not charge). */
export async function checkX402Balance(
  baseUrl: string,
  privateKey: `0x${string}`,
): Promise<{ canConsume: boolean; balanceUsd: number; diemBalanceUsd: number; address: string }> {
  const { header, address } = await buildSiwxHeader(privateKey, `${baseUrl}/x402/balance`);
  const res = await fetch(`${baseUrl}/x402/balance/${address}`, {
    headers: { "X-Sign-In-With-X": header },
  });
  if (!res.ok) {
    throw new Error(`x402 balance check failed: ${res.status} ${await res.text()}`);
  }
  // Venice wraps the payload as { success, data: { ... } }; tolerate both shapes.
  const json = (await res.json()) as {
    success?: boolean;
    data?: { canConsume?: boolean; balanceUsd?: number; diemBalanceUsd?: number };
    canConsume?: boolean;
    balanceUsd?: number;
    diemBalanceUsd?: number;
  };
  const data = json.data ?? json;
  return {
    canConsume: Boolean(data.canConsume),
    balanceUsd: data.balanceUsd ?? 0,
    diemBalanceUsd: data.diemBalanceUsd ?? 0,
    address,
  };
}
