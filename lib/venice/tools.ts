// ─────────────────────────────────────────────────────────────────────────────
// On-chain tools the agent can call live, whenever it decides to.
//
// This is what turns the analyst from "frozen snapshot" into a real agent: it
// can re-read balances, look up any address, read contract fields, and pull
// recent logs ON DEMAND mid-conversation — via Venice Crypto RPC.
//
// These are exposed to the model as OpenAI-style function tools. Tool calling is
// only supported on non-E2EE (web-capable) models, so this layer is used in the
// agentic chat path, not the E2EE path.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeFunctionData, parseAbi, decodeAbiParameters } from "viem";
import type { CryptoRpcClient } from "./rpc";
import { SUPPORTED_NETWORKS } from "../util";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const NETWORK_ENUM = [...SUPPORTED_NETWORKS];

// The tool schemas advertised to the model.
export const ONCHAIN_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "scan_wallet_holdings",
      description:
        "BEST FIRST CHOICE for 'what's in this wallet?'. In ONE batched call, returns the native balance AND the balances of a broad set of common tokens on the network (USDC, USDT, WETH, DAI, VVV, etc.). Far more efficient than checking tokens one by one. Use this first; only fall back to per-token or log-scan tools for assets it doesn't cover.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "0x-prefixed EVM address" },
          network: { type: "string", enum: NETWORK_ENUM, description: "Network slug, default base-mainnet" },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_native_balance",
      description:
        "Get ONLY the native coin balance (ETH/POL/AVAX/BNB) of an address. Use to quickly re-check native balance, e.g. after the user says ETH was sent. For full holdings use scan_wallet_holdings.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "0x-prefixed EVM address" },
          network: { type: "string", enum: NETWORK_ENUM, description: "Network slug, default base-mainnet" },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_overview",
      description:
        "Get a full live overview of an address: native balance, transaction count (nonce), whether it is a smart contract, and the latest block. Use for a fresh read of any wallet or contract.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "0x-prefixed EVM address" },
          network: { type: "string", enum: NETWORK_ENUM },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erc20_balance",
      description:
        "Read ONE specific ERC-20 token balance for a holder (returns symbol + decimals). Use only for a particular token the user named, or one not covered by scan_wallet_holdings. Do NOT loop this over many tokens — call scan_wallet_holdings instead.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "ERC-20 contract address (0x...)" },
          holder: { type: "string", description: "Holder address (0x...)" },
          network: { type: "string", enum: NETWORK_ENUM },
        },
        required: ["token", "holder"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_token_metadata",
      description:
        "Read an ERC-20 token's name, symbol, decimals, and total supply directly from its contract. Use to identify what a token actually is on-chain.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "ERC-20 contract address (0x...)" },
          network: { type: "string", enum: NETWORK_ENUM },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rpc_call",
      description:
        "Escape hatch: make a raw JSON-RPC call to a network for anything the higher-level tools don't cover (e.g. eth_getLogs, eth_getTransactionReceipt, eth_getCode, eth_call). Returns the raw result.",
      parameters: {
        type: "object",
        properties: {
          network: { type: "string", enum: NETWORK_ENUM },
          method: { type: "string", description: "JSON-RPC method, e.g. eth_getTransactionReceipt" },
          params: { type: "array", description: "JSON-RPC params array", items: {} },
        },
        required: ["method", "params"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate an image with Venice's image API (paid via the same x402 wallet credential as inference). Use when the user asks to create/draw/visualize something — e.g. a visual card of their wallet holdings. Provide a vivid, self-contained prompt; include any on-chain numbers you want shown (you already have them from prior tool calls). The image is displayed to the user automatically.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Full image prompt. Be descriptive; bake in any balances/labels you want rendered.",
          },
          aspect_ratio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
            description: "Aspect ratio, default 1:1",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

function fmtUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  let v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${out}` : out;
}

function net(n?: string): string {
  const v = (n || "base-mainnet").trim();
  return (SUPPORTED_NETWORKS as readonly string[]).includes(v) ? v : "base-mainnet";
}

async function rawCall(rpc: CryptoRpcClient, network: string, method: string, params: unknown[]) {
  // CryptoRpcClient.call is private; use the public single helper.
  return rpc.single(network, method, params);
}

/** Execute a tool call by name. Returns a JSON-serializable result object. */
export async function runTool(
  rpc: CryptoRpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const network = net(args.network as string | undefined);

  switch (name) {
    case "scan_wallet_holdings": {
      const address = String(args.address);
      const snap = await rpc.getWalletSnapshot(address, network);
      return {
        address: snap.address,
        network: snap.network,
        isContract: snap.isContract,
        txCount: snap.txCount,
        latestBlock: snap.latestBlock,
        native: { symbol: snap.nativeSymbol, balance: snap.nativeBalance },
        tokens: snap.tokens.map((t) => ({ symbol: t.symbol, balance: t.formatted, contract: t.contract })),
        note:
          snap.tokens.length === 0
            ? "No balance found among the common tokens scanned. The wallet may hold other tokens; use get_erc20_balance for a specific contract or rpc_call/eth_getLogs to discover transfers."
            : undefined,
      };
    }

    case "get_native_balance": {
      const address = String(args.address);
      const hex = (await rawCall(rpc, network, "eth_getBalance", [address, "latest"])) as string;
      const wei = BigInt(hex ?? "0x0");
      return { address, network, wei: wei.toString(), formatted: fmtUnits(wei, 18) };
    }

    case "get_account_overview": {
      const address = String(args.address);
      const [blockHex, balHex, nonceHex, code] = (await Promise.all([
        rawCall(rpc, network, "eth_blockNumber", []),
        rawCall(rpc, network, "eth_getBalance", [address, "latest"]),
        rawCall(rpc, network, "eth_getTransactionCount", [address, "latest"]),
        rawCall(rpc, network, "eth_getCode", [address, "latest"]),
      ])) as string[];
      const wei = BigInt(balHex ?? "0x0");
      return {
        address,
        network,
        nativeBalance: fmtUnits(wei, 18),
        nativeWei: wei.toString(),
        txCount: Number(BigInt(nonceHex ?? "0x0")),
        isContract: code !== "0x" && (code?.length ?? 0) > 2,
        latestBlock: Number(BigInt(blockHex ?? "0x0")),
      };
    }

    case "get_erc20_balance": {
      const token = String(args.token);
      const holder = String(args.holder);
      const [balHex, decHex, symHex] = (await Promise.all([
        rawCall(rpc, network, "eth_call", [
          { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [holder as `0x${string}`] }) },
          "latest",
        ]),
        rawCall(rpc, network, "eth_call", [
          { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }) },
          "latest",
        ]),
        rawCall(rpc, network, "eth_call", [
          { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }) },
          "latest",
        ]),
      ])) as string[];
      const raw = BigInt(balHex && balHex !== "0x" ? balHex : "0x0");
      const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
      let symbol = "?";
      try {
        symbol = decodeAbiParameters([{ type: "string" }], symHex as `0x${string}`)[0] as string;
      } catch {
        /* some tokens return bytes32 symbols; ignore */
      }
      return { token, holder, network, symbol, decimals, raw: raw.toString(), formatted: fmtUnits(raw, decimals) };
    }

    case "read_token_metadata": {
      const token = String(args.token);
      const call = (fn: "name" | "symbol" | "decimals" | "totalSupply") =>
        rawCall(rpc, network, "eth_call", [
          { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: fn }) },
          "latest",
        ]) as Promise<string>;
      const [nameHex, symHex, decHex, supHex] = await Promise.all([
        call("name"),
        call("symbol"),
        call("decimals"),
        call("totalSupply"),
      ]);
      const dec = (h: string) => {
        try {
          return decodeAbiParameters([{ type: "string" }], h as `0x${string}`)[0] as string;
        } catch {
          return undefined;
        }
      };
      const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
      const supply = supHex && supHex !== "0x" ? BigInt(supHex) : 0n;
      return {
        token,
        network,
        name: dec(nameHex),
        symbol: dec(symHex),
        decimals,
        totalSupply: fmtUnits(supply, decimals),
      };
    }

    case "rpc_call": {
      const method = String(args.method);
      const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
      const result = await rawCall(rpc, network, method, params);
      return { network, method, result };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
