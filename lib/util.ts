export function isEvmAddress(addr: string): addr is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

// EVM networks Venice Crypto RPC supports (the agent reads on-chain data here).
// Note: Solana is NOT here — Crypto RPC is EVM/Starknet only. Solana is a
// payment rail for x402, which is a separate concern from reads.
export const SUPPORTED_NETWORKS = [
  "base-mainnet",
  "ethereum-mainnet",
  "arbitrum-mainnet",
  "optimism-mainnet",
  "polygon-mainnet",
  "avalanche-mainnet",
  "bsc-mainnet",
  "linea-mainnet",
  "blast-mainnet",
  "zksync-mainnet",
] as const;

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];
