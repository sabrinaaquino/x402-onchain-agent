// ─────────────────────────────────────────────────────────────────────────────
// Unified Venice client — per-surface authentication.
//
// One client, two surfaces: inference (chat, including E2EE) AND blockchain
// access (Crypto RPC). Each surface picks its own credential:
//
//   • Inference  → x402 wallet auth (preferred). "Inference powered by x402"
//                  stays literally true. Falls back to API key if no wallet.
//   • Crypto RPC → API key (preferred), because x402 USDC top-ups are currently
//                  not accepted by the /crypto/rpc route on Venice's side
//                  (inference accepts them fine). Falls back to x402 if no key.
//
// When the x402-RPC path is fixed upstream, just remove VENICE_API_KEY and the
// whole agent is pure x402 again — no code change needed.
//
// WORKSHOP SECTIONS COVERED HERE:
//   • "Venice API intro — models, endpoints / DIEM"  (chat, /models)
//   • "Venice x402 intro" + "Inference powered by x402"  (x402 auth)
//   • "Venice Crypto RPC intro"  (rpc passthrough)
//   • "Venice E2EE"  (private analysis)
// ─────────────────────────────────────────────────────────────────────────────

import type { AuthMode, ChatMessage, VeniceConfig } from "./types";
import { buildSiwxHeader, checkX402Balance } from "./x402";
import { CryptoRpcClient } from "./rpc";
import { fetchAndVerifyAttestation, e2eeChatCompletion } from "./e2ee";
import { loadWalletKey } from "./keystore";
import { isPrivateModel } from "./models";
import { ONCHAIN_TOOLS, runTool } from "./tools";

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "image"; dataUrl: string; model: string };

export interface ChatResult {
  text: string;
  model: string;
  e2ee: boolean;
  attested: boolean;
  teeProvider?: string;
  webSearch: boolean;
}

export class VeniceClient {
  readonly config: VeniceConfig;
  /** This agent authenticates EVERYTHING via x402 wallet auth. */
  readonly inferenceAuth = "x402" as const;
  readonly rpcAuth = "x402" as const;
  readonly effectiveAuthMode = "x402" as const;
  readonly rpc: CryptoRpcClient;
  private walletKey: `0x${string}`;

  constructor(config: VeniceConfig) {
    this.config = config;

    // x402-only: the wallet pays for inference, Crypto RPC, AND image generation.
    // Crypto RPC via x402 is fully supported now, so there is no API-key path.
    if (!config.walletPrivateKey) {
      throw new Error(
        "No wallet key available. Set WALLET_PRIVATE_KEY (or a KEYSTORE_PATH + " +
          "KEYSTORE_PASSPHRASE). This agent authenticates to Venice via x402 only.",
      );
    }
    this.walletKey = config.walletPrivateKey;

    this.rpc = new CryptoRpcClient(config.baseUrl, (url) => this.rpcHeadersFor(url));
  }

  /** Auth headers for any Venice route — a fresh x402 SIWE signature per request. */
  async authHeadersFor(resourceUrl: string): Promise<Record<string, string>> {
    const { header } = await buildSiwxHeader(this.walletKey, resourceUrl);
    return { "X-Sign-In-With-X": header };
  }

  /** Crypto RPC uses the same x402 credential as everything else. */
  async rpcHeadersFor(resourceUrl: string): Promise<Record<string, string>> {
    return this.authHeadersFor(resourceUrl);
  }

  /** Standard (non-E2EE) chat completion. Used for non-sensitive helper calls. */
  async chat(messages: ChatMessage[], model = this.config.fastModel): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = { ...(await this.authHeadersFor(url)), "Content-Type": "application/json" };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) {
      throw new Error(`Chat failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Private chat completion via an E2EE model. The prompt is encrypted client-
   * side and only the attested TEE can read it. Returns the decrypted text plus
   * the privacy context for display.
   */
  async privateChat(
    messages: ChatMessage[],
    onToken?: (t: string) => void,
    modelOverride?: string,
  ): Promise<ChatResult> {
    const model = modelOverride || this.config.e2eeModel;
    const authHeaders = await this.authHeadersFor(`${this.config.baseUrl}/tee/attestation`);
    const ctx = await fetchAndVerifyAttestation(this.config.baseUrl, model, authHeaders);

    // Re-derive auth for the completion call (x402 needs a fresh signature).
    const completionAuth = await this.authHeadersFor(`${this.config.baseUrl}/chat/completions`);
    const text = await e2eeChatCompletion({
      baseUrl: this.config.baseUrl,
      model,
      messages,
      authHeaders: completionAuth,
      ctx,
      onToken,
    });

    return { text, model, e2ee: true, attested: ctx.verified, teeProvider: ctx.teeProvider, webSearch: false };
  }

  /**
   * Streaming completion on a normal (non-E2EE) model, optionally with live web
   * search enabled via venice_parameters. Used for the "web-capable top model"
   * mode where we trade client-side encryption for fresh, real-world knowledge.
   */
  async webChat(
    messages: ChatMessage[],
    model: string,
    onToken?: (t: string) => void,
    enableWebSearch = true,
  ): Promise<ChatResult> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = { ...(await this.authHeadersFor(url)), "Content-Type": "application/json" };
    const body: Record<string, unknown> = { model, messages, stream: true };
    if (enableWebSearch) {
      body.venice_parameters = { enable_web_search: "auto", enable_web_citations: true };
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      throw new Error(`Web chat failed: ${res.status} ${await res.text().catch(() => "")}`);
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
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]" || data.length === 0) continue;
        try {
          const chunk = JSON.parse(data);
          const piece: string | undefined = chunk?.choices?.[0]?.delta?.content;
          if (piece) {
            full += piece;
            onToken?.(piece);
          }
        } catch {
          /* skip partial chunks */
        }
      }
    }
    return { text: full, model, e2ee: false, attested: false, webSearch: enableWebSearch };
  }

  /**
   * Route to the right path based on the model id: E2EE models go through the
   * encrypted flow; everything else uses the web-capable streaming flow.
   */
  async streamChat(
    messages: ChatMessage[],
    model: string,
    onToken?: (t: string) => void,
  ): Promise<ChatResult> {
    if (isPrivateModel(model)) {
      return this.privateChat(messages, onToken, model);
    }
    return this.webChat(messages, model, onToken, true);
  }

  /**
   * Agentic chat with live on-chain tools. The model can call Crypto RPC tools
   * (balances, account overview, token reads, raw rpc) across multiple rounds,
   * re-reading the chain whenever it decides to — not bound to a snapshot.
   *
   * Tool calling requires a non-E2EE model (Venice disables tools under E2EE),
   * so the caller should pass a web-capable model id here.
   *
   * Emits AgentEvents (tokens, tool_call, tool_result) via `onEvent`.
   */
  async agentChat(
    messages: ChatMessage[],
    model: string,
    onEvent: (e: AgentEvent) => void,
    opts: { enableWebSearch?: boolean; maxRounds?: number } = {},
  ): Promise<ChatResult> {
    const enableWebSearch = opts.enableWebSearch ?? true;
    const maxRounds = opts.maxRounds ?? 6;
    const url = `${this.config.baseUrl}/chat/completions`;

    // Working conversation; tool roles get appended as the loop runs.
    const convo: Record<string, unknown>[] = messages.map((m) => ({ role: m.role, content: m.content }));
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      const headers = { ...(await this.authHeadersFor(url)), "Content-Type": "application/json" };
      const body: Record<string, unknown> = {
        model,
        messages: convo,
        stream: true,
        tools: ONCHAIN_TOOLS,
        tool_choice: "auto",
      };
      if (enableWebSearch) {
        body.venice_parameters = { enable_web_search: "auto", enable_web_citations: true };
      }

      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        throw new Error(`Agent chat failed: ${res.status} ${await res.text().catch(() => "")}`);
      }

      // Accumulate this round's streamed assistant message + any tool calls.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let roundText = "";
      const toolCalls: { id?: string; name: string; argStr: string }[] = [];

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]" || data.length === 0) continue;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk?.choices?.[0]?.delta;
            if (!delta) continue;
            if (typeof delta.content === "string" && delta.content) {
              roundText += delta.content;
              finalText += delta.content;
              onEvent({ type: "token", text: delta.content });
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, name: "", argStr: "" };
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].argStr += tc.function.arguments;
              }
            }
          } catch {
            /* skip partial chunks */
          }
        }
      }

      // No tool calls this round → the model produced its final answer.
      const valid = toolCalls.filter((c) => c && c.name);
      if (valid.length === 0) {
        return { text: finalText, model, e2ee: false, attested: false, webSearch: enableWebSearch };
      }

      // Record the assistant's tool-call turn, then execute each tool.
      convo.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: valid.map((c, i) => ({
          id: c.id || `call_${round}_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.argStr || "{}" },
        })),
      });

      for (let i = 0; i < valid.length; i++) {
        const c = valid[i];
        let args: Record<string, unknown> = {};
        try {
          args = c.argStr ? JSON.parse(c.argStr) : {};
        } catch {
          args = {};
        }
        onEvent({ type: "tool_call", name: c.name, args });
        let result: unknown;
        try {
          if (c.name === "generate_image") {
            // Special-cased: uses inference (x402) auth + emits the image to the
            // UI directly. We feed only a short confirmation back to the model so
            // the base64 blob never bloats the conversation context.
            const img = await this.generateImage({
              prompt: String(args.prompt ?? ""),
              aspectRatio: args.aspect_ratio as string | undefined,
            });
            onEvent({ type: "image", dataUrl: img.dataUrl, model: img.model });
            result = { ok: true, model: img.model, note: "Image generated and displayed to the user." };
          } else {
            result = await runTool(this.rpc, c.name, args);
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        onEvent({ type: "tool_result", name: c.name, result });
        convo.push({
          role: "tool",
          tool_call_id: c.id || `call_${round}_${i}`,
          content: JSON.stringify(result),
        });
      }
      // loop again so the model can use the tool results
    }

    return { text: finalText, model, e2ee: false, attested: false, webSearch: enableWebSearch };
  }

  /**
   * Generate an image via Venice's /image/generate, paid with the same x402
   * inference credential. Returns a data URL (data:image/...;base64,...).
   */
  async generateImage(opts: {
    prompt: string;
    model?: string;
    aspectRatio?: string;
  }): Promise<{ dataUrl: string; model: string }> {
    const model = opts.model || "grok-imagine-image-quality";
    const url = `${this.config.baseUrl}/image/generate`;
    const headers = { ...(await this.authHeadersFor(url)), "Content-Type": "application/json" };
    const body = {
      model,
      prompt: opts.prompt,
      aspect_ratio: opts.aspectRatio || "1:1",
      format: "webp",
      return_binary: false,
    };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      throw new Error(`Image generation failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as {
      images?: string[]; // Venice /image/generate: array of base64 strings
      data?: { b64_json?: string; url?: string }[]; // OpenAI-compatible fallback
    };

    // Venice native shape: { images: ["<base64 webp>"] }
    const b64 = json.images?.[0];
    if (b64) {
      const payload = b64.startsWith("data:") ? b64 : `data:image/webp;base64,${b64}`;
      return { dataUrl: payload, model };
    }
    // OpenAI-compatible shape: { data: [{ b64_json | url }] }
    const first = json.data?.[0];
    if (first?.url) return { dataUrl: first.url, model };
    if (first?.b64_json) return { dataUrl: `data:image/webp;base64,${first.b64_json}`, model };

    throw new Error("Image generation returned no image payload.");
  }

  /** The agent always has an x402 wallet (it's required). */
  get hasWallet(): boolean {
    return true;
  }

  /** x402 spendable balance (USDC credits + any DIEM) for the agent wallet. */
  async walletBalance() {
    return checkX402Balance(this.config.baseUrl, this.walletKey);
  }
}

/** Build a VeniceClient from environment variables. Server-side only. */
export function veniceFromEnv(env: NodeJS.ProcessEnv = process.env): VeniceClient {
  const walletPrivateKey = loadWalletKey(env);

  return new VeniceClient({
    baseUrl: env.VENICE_BASE_URL || "https://api.venice.ai/api/v1",
    walletPrivateKey,
    e2eeModel: env.E2EE_MODEL || "e2ee-qwen3-5-122b-a10b",
    fastModel: env.FAST_MODEL || "kimi-k2-5",
    defaultNetwork: env.DEFAULT_NETWORK || "base-mainnet",
  });
}
