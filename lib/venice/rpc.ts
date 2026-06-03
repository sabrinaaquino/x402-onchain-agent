// ─────────────────────────────────────────────────────────────────────────────
// Venice Crypto RPC client.
//
// WORKSHOP SECTION: "Venice Crypto RPC intro" + "On-chain analysis powered by
// Crypto RPC".
//
// One Venice credential gives us JSON-RPC access to 10 EVM chains + Starknet.
// We send standard JSON-RPC 2.0 to POST /crypto/rpc/{network}. Responses carry
// X-Venice-RPC-Credits / X-Venice-RPC-Cost-USD headers so we can show spend.
//
// Auth is whatever the VeniceClient injects (Bearer key OR x402 SIWX header) —
// the same credential that pays for inference also pays for RPC.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeFunctionData, parseAbi } from "viem";
import type { RpcCall, RpcResponse, RpcMeta, TokenHolding, WalletSnapshot } from "./types";

// A small curated token list per chain keeps the demo snappy and dependency-free.
// (Real apps would use a token-list/indexer; this is enough to show holdings.)
// A curated common-token list per chain. One batched eth_call covers all of
// them in a single request, so "what's in this wallet?" is one tool call.
const KNOWN_TOKENS: Record<string, { symbol: string; contract: string; decimals: number }[]> = {
  "base-mainnet": [
    { symbol: "USDC", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { symbol: "USDbC", contract: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
    { symbol: "WETH", contract: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "cbETH", contract: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
    { symbol: "cbBTC", contract: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    { symbol: "DAI", contract: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    { symbol: "AERO", contract: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
    { symbol: "VVV", contract: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf", decimals: 18 },
    { symbol: "DEGEN", contract: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18 },
    { symbol: "USDT", contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
  ],
  "ethereum-mainnet": [
    { symbol: "USDC", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "USDT", contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "WETH", contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    { symbol: "DAI", contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    { symbol: "WBTC", contract: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
    { symbol: "stETH", contract: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", decimals: 18 },
    { symbol: "LINK", contract: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
    { symbol: "UNI", contract: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  ],
  "arbitrum-mainnet": [
    { symbol: "USDC", contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "WETH", contract: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    { symbol: "ARB", contract: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
  ],
  "optimism-mainnet": [
    { symbol: "USDC", contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { symbol: "USDT", contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    { symbol: "WETH", contract: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "OP", contract: "0x4200000000000000000000000000000000000042", decimals: 18 },
  ],
  "polygon-mainnet": [
    { symbol: "USDC", contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { symbol: "USDT", contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    { symbol: "WETH", contract: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    { symbol: "WPOL", contract: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  ],
};

const NATIVE_SYMBOL: Record<string, string> = {
  "ethereum-mainnet": "ETH",
  "base-mainnet": "ETH",
  "arbitrum-mainnet": "ETH",
  "optimism-mainnet": "ETH",
  "polygon-mainnet": "POL",
  "avalanche-mainnet": "AVAX",
  "bsc-mainnet": "BNB",
  "linea-mainnet": "ETH",
  "blast-mainnet": "ETH",
  "zksync-mainnet": "ETH",
};

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  let v = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  fracStr = fracStr.slice(0, 6); // trim to 6 dp for display
  const out = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${out}` : out;
}

export class CryptoRpcClient {
  constructor(
    private baseUrl: string,
    /** Returns fresh auth headers for a given resource URL (key or x402). */
    private authHeadersFor: (resourceUrl: string) => Promise<Record<string, string>>,
  ) {}

  private async call<T = unknown>(
    network: string,
    payload: RpcCall | RpcCall[],
  ): Promise<{ data: RpcResponse<T> | RpcResponse<T>[]; meta: RpcMeta }> {
    const url = `${this.baseUrl}/crypto/rpc/${network}`;
    const headers = {
      ...(await this.authHeadersFor(url)),
      "Content-Type": "application/json",
    };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      throw new Error(`Crypto RPC ${network} failed: ${res.status} ${await res.text()}`);
    }
    const meta: RpcMeta = {
      creditsCharged: res.headers.get("X-Venice-RPC-Credits") ?? undefined,
      costUsd: res.headers.get("X-Venice-RPC-Cost-USD") ?? undefined,
      requestId: res.headers.get("X-Request-ID") ?? undefined,
    };
    return { data: (await res.json()) as RpcResponse<T> | RpcResponse<T>[], meta };
  }

  /**
   * Public single JSON-RPC call. Used by the live agent tools. Returns the
   * `result` field (or throws on a JSON-RPC error).
   */
  async single<T = unknown>(network: string, method: string, params: unknown[]): Promise<T> {
    const { data } = await this.call<T>(network, { jsonrpc: "2.0", method, params, id: 1 });
    const r = Array.isArray(data) ? data[0] : data;
    if (r?.error) throw new Error(`${method} failed: ${r.error.message}`);
    return r?.result as T;
  }

  /**
   * Pull a full on-chain snapshot for an address using a single batched RPC
   * call (block number, balance, tx count, code) plus one batched call for the
   * known token balances. Two requests total — cheap and fast.
   */
  async getWalletSnapshot(address: string, network: string): Promise<WalletSnapshot> {
    let totalCostUsd = 0;
    let rpcCalls = 0;

    // Batch 1: core account state.
    const coreBatch: RpcCall[] = [
      { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 },
      { jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 2 },
      { jsonrpc: "2.0", method: "eth_getTransactionCount", params: [address, "latest"], id: 3 },
      { jsonrpc: "2.0", method: "eth_getCode", params: [address, "latest"], id: 4 },
    ];
    const core = await this.call<string>(network, coreBatch);
    rpcCalls += coreBatch.length;
    totalCostUsd += Number(core.meta.costUsd ?? 0);

    const byId = new Map<number, string>();
    if (Array.isArray(core.data)) {
      for (const r of core.data) {
        if (r.result !== undefined) byId.set(r.id, r.result as string);
      }
    }

    const latestBlock = Number(BigInt(byId.get(1) ?? "0x0"));
    const nativeWei = BigInt(byId.get(2) ?? "0x0");
    const txCount = Number(BigInt(byId.get(3) ?? "0x0"));
    const code = byId.get(4) ?? "0x";
    const isContract = code !== "0x" && code.length > 2;

    // Batch 2: ERC-20 balanceOf for known tokens on this chain.
    const tokenDefs = KNOWN_TOKENS[network] ?? [];
    const tokens: TokenHolding[] = [];
    if (tokenDefs.length > 0) {
      const tokenBatch: RpcCall[] = tokenDefs.map((t, i) => ({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [
          { to: t.contract, data: encodeFunctionData({ abi: ERC20_ABI, args: [address as `0x${string}`] }) },
          "latest",
        ],
        id: 100 + i,
      }));
      const tokenRes = await this.call<string>(network, tokenBatch);
      rpcCalls += tokenBatch.length;
      totalCostUsd += Number(tokenRes.meta.costUsd ?? 0);

      const tokById = new Map<number, string>();
      if (Array.isArray(tokenRes.data)) {
        for (const r of tokenRes.data) {
          if (r.result !== undefined) tokById.set(r.id, r.result as string);
        }
      }
      tokenDefs.forEach((t, i) => {
        const hex = tokById.get(100 + i);
        if (!hex || hex === "0x") return;
        const raw = BigInt(hex);
        if (raw === 0n) return;
        tokens.push({
          symbol: t.symbol,
          contract: t.contract,
          raw: raw.toString(),
          decimals: t.decimals,
          formatted: formatUnits(raw, t.decimals),
        });
      });
    }

    return {
      address,
      network,
      nativeSymbol: NATIVE_SYMBOL[network] ?? "ETH",
      nativeBalance: formatUnits(nativeWei, 18),
      nativeBalanceWei: nativeWei.toString(),
      txCount,
      isContract,
      latestBlock,
      tokens,
      rpcCostUsd: totalCostUsd,
      rpcCalls,
    };
  }
}
