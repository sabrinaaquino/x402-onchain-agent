// Shared types for the Venice client + on-chain analyst.

// This agent authenticates everything via x402 wallet auth.
export type AuthMode = "x402";

export interface VeniceConfig {
  baseUrl: string;
  walletPrivateKey?: `0x${string}`;
  e2eeModel: string;
  fastModel: string;
  defaultNetwork: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RpcCall {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export interface RpcMeta {
  creditsCharged?: string;
  costUsd?: string;
  requestId?: string;
}

export interface TokenHolding {
  symbol: string;
  contract: string;
  raw: string; // decimal string (BigInt isn't JSON-serializable)
  decimals: number;
  formatted: string;
}

export interface WalletSnapshot {
  address: string;
  network: string;
  nativeSymbol: string;
  nativeBalance: string;
  nativeBalanceWei: string; // decimal string (BigInt isn't JSON-serializable)
  txCount: number;
  isContract: boolean;
  latestBlock: number;
  tokens: TokenHolding[];
  rpcCostUsd: number;
  rpcCalls: number;
}

export interface AnalysisResult {
  snapshot: WalletSnapshot;
  report: string;
  privacy: {
    e2ee: boolean;
    model: string;
    attested: boolean;
    teeProvider?: string;
    webSearch?: boolean;
  };
  auth: AuthMode;
}
