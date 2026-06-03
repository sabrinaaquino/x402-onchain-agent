import { NextRequest } from "next/server";
import { veniceFromEnv } from "@/lib/venice/client";
import { isPrivateModel } from "@/lib/venice/models";
import type { ChatMessage } from "@/lib/venice/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agent
 * Body: { messages: {role,content}[], model: string, network?: string }
 *
 * The chat-first on-chain agent. On a web-capable model it can call live Crypto
 * RPC tools (balances, account overview, token reads, raw rpc) across multiple
 * rounds — it reads the chain whenever it decides to, not from a frozen snapshot.
 *
 * On an E2EE model, tools are disabled (Venice doesn't allow tool calls under
 * encryption); it runs as a private, no-tools chat.
 *
 * Streams SSE:
 *   event: token        → assistant text chunk
 *   event: tool_call    → { name, args }
 *   event: tool_result  → { name, result }
 *   event: done         → { privacy }
 *   event: error        → { message }
 */
export async function POST(req: NextRequest) {
  let body: { messages?: ChatMessage[]; model?: string; network?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const history = Array.isArray(body.messages) ? body.messages : [];
  if (history.length === 0) {
    return Response.json({ error: "messages[] is required" }, { status: 400 });
  }
  const network = (body.network ?? "base-mainnet").trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const client = veniceFromEnv();
        const model = (body.model ?? "").trim() || client.config.fastModel;
        const priv = isPrivateModel(model);

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt(priv, network) },
          ...history.filter(
            (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          ),
        ];

        if (priv) {
          // E2EE: private, no tools. Re-runs the encrypted flow each turn.
          const r = await client.privateChat(messages, (t) => send("token", t), model);
          send("done", {
            privacy: { e2ee: true, attested: r.attested, teeProvider: r.teeProvider, model: r.model, webSearch: false, tools: false },
          });
        } else {
          // Web model: agentic, live on-chain tools + web search.
          const r = await client.agentChat(
            messages,
            model,
            (e) => {
              if (e.type === "token") send("token", e.text);
              else if (e.type === "tool_call") send("tool_call", { name: e.name, args: e.args });
              else if (e.type === "tool_result") send("tool_result", { name: e.name, result: e.result });
              else if (e.type === "image") send("image", { dataUrl: e.dataUrl, model: e.model });
            },
            { enableWebSearch: true },
          );
          send("done", {
            privacy: { e2ee: false, attested: false, model: r.model, webSearch: true, tools: true },
          });
        }
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function systemPrompt(priv: boolean, network: string): string {
  const base = `You are an autonomous on-chain analyst agent. You help the user
investigate wallets, contracts, and tokens on EVM chains. Answer in clear Markdown
(headings, bold, lists, small tables, code spans). Lead with the answer. Never give
financial advice — frame risk as heuristics.

Default network is ${network}, but the user may name any supported chain. When the
user gives an address, figure out what they want and proceed.`;

  if (priv) {
    return `${base}

You are in PRIVATE (E2EE) mode: your prompt is encrypted client-side and you have
NO live tools and NO web access this turn. Reason from what the user tells you and
general knowledge. If you need a live on-chain read (balance, contract state, logs)
or external facts, say so plainly and suggest the user switch to a web model for
live tool access.`;
  }

  return `${base}

You have LIVE TOOLS — call them whenever you need fresh on-chain data, and call
them again to re-check (e.g. when the user says funds were just sent):
- scan_wallet_holdings(address, network): ONE batched call returning native + all
  common token balances. THIS IS YOUR DEFAULT for "what's in this wallet / what
  tokens does it hold". Use it FIRST. Do not check tokens one-by-one.
- get_account_overview(address, network): native balance, nonce, isContract, block
- get_native_balance(address, network): native only
- get_erc20_balance(token, holder, network): ONE specific token (named by user, or
  not covered by the scan). Never loop this across many tokens.
- read_token_metadata(token, network): name/symbol/decimals/totalSupply
- rpc_call(network, method, params): raw JSON-RPC escape hatch (eth_getLogs, receipts, eth_call, eth_getCode, ...)
- generate_image(prompt, aspect_ratio): create an image via Venice's image API,
  paid with the same x402 wallet. Use it when the user asks to draw/visualize/make
  an image (e.g. "an image of my wallet holdings"). First gather the data you need
  (e.g. scan_wallet_holdings), then write a vivid prompt that bakes in the actual
  balances/labels. The image is shown to the user automatically — just confirm it.

You CAN generate images and pay for them via x402 — do not claim you lack that
ability. If asked for "an image of my holdings", scan the wallet, then call
generate_image with a prompt describing a clean infographic/card of those holdings.

Efficiency rules:
- "What tokens / what's in this wallet?" → call scan_wallet_holdings ONCE, then
  answer. Only dig deeper (logs, specific tokens) if the user asks or the scan
  clearly missed something they mentioned.
- Avoid long sequences of similar calls. Prefer one batched/high-level tool.

You also have live web search for off-chain context (what a token/protocol is,
news, labels). Prefer calling a tool over guessing. When the user disputes your
data ("there IS ETH, check again"), RE-CALL the relevant tool rather than insisting
on a stale value. Briefly note when a figure came from a live read vs. web.`;
}
