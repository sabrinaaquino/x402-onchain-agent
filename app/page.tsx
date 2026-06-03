"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

interface ModelOption {
  id: string;
  label: string;
  mode: "private" | "web";
  reasoning: boolean;
  note: string;
}

interface Health {
  ok: boolean;
  inferenceAuth?: string;
  rpcAuth?: string;
  wallet?: { balanceUsd: number; canConsume: boolean };
  error?: string;
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; result?: unknown }
  | { kind: "image"; dataUrl: string; model: string };

interface Turn {
  role: "user" | "assistant";
  parts: Part[];
}

const SUGGESTIONS = [
  {
    icon: "🔍",
    title: "Analyze a contract",
    hint: "Inspect the VVV token on Base",
    prompt: "Analyze 0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf on Base",
  },
  {
    icon: "💰",
    title: "Check wallet holdings",
    hint: "vitalik.eth on Ethereum",
    prompt: "What tokens are in 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 on Ethereum?",
  },
  {
    icon: "🖼️",
    title: "Visualize a wallet",
    hint: "Generate an image of its holdings",
    prompt: "Scan the holdings of 0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf on Base, then generate an infographic image of them",
  },
];

const TOOL_LABEL: Record<string, string> = {
  get_account_overview: "Reading account overview",
  get_native_balance: "Reading native balance",
  get_erc20_balance: "Reading token balance",
  read_token_metadata: "Reading token metadata",
  rpc_call: "Raw RPC call",
  scan_wallet_holdings: "Scanning wallet holdings",
  generate_image: "Generating image (x402)",
};

const STORE_KEY = "venice-agent-conversations";

interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// Strip heavy image base64 before persisting, to stay under localStorage quota.
function lightweightTurns(turns: Turn[]): Turn[] {
  return turns.map((t) => ({
    role: t.role,
    parts: t.parts.map((p) =>
      p.kind === "image" ? { kind: "image" as const, dataUrl: "", model: p.model } : p,
    ),
  }));
}

export default function Home() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth({ ok: false, error: "health failed" }));
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.options?.length) {
          setModels(d.options);
          const firstWeb = d.options.find((m: ModelOption) => m.mode === "web");
          setModelId((firstWeb ?? d.options[0]).id);
        }
      })
      .catch(() => {});

    // Load saved conversations.
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const saved: Conversation[] = raw ? JSON.parse(raw) : [];
      if (saved.length > 0) {
        setConversations(saved);
        setActiveId(saved[0].id);
        setTurns(saved[0].turns);
      } else {
        const c = { id: newId(), title: "New chat", turns: [] };
        setConversations([c]);
        setActiveId(c.id);
      }
    } catch {
      const c = { id: newId(), title: "New chat", turns: [] };
      setConversations([c]);
      setActiveId(c.id);
    }
    loaded.current = true;
  }, []);

  const currentModel = models.find((m) => m.id === modelId);
  const isPrivate = currentModel?.mode === "private";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  // Keep the active conversation in sync with the working `turns`, derive its
  // title from the first user message, and persist to localStorage.
  useEffect(() => {
    if (!loaded.current || !activeId) return;
    setConversations((prev) => {
      const next = prev.map((c) => {
        if (c.id !== activeId) return c;
        const firstUser = turns.find((t) => t.role === "user");
        const title =
          firstUser?.parts.map((p) => (p.kind === "text" ? p.text : "")).join("").slice(0, 48) ||
          "New chat";
        return { ...c, title, turns };
      });
      try {
        const lite = next.map((c) => ({ ...c, turns: lightweightTurns(c.turns) }));
        localStorage.setItem(STORE_KEY, JSON.stringify(lite));
      } catch {
        /* quota — ignore */
      }
      return next;
    });
  }, [turns, activeId]);

  function newChat() {
    if (busy) return;
    const c = { id: newId(), title: "New chat", turns: [] };
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setTurns([]);
    setInput("");
  }

  function selectChat(id: string) {
    if (busy || id === activeId) return;
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    setActiveId(id);
    setTurns(c.turns);
    setInput("");
  }

  function deleteChat(id: string) {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      const list = next.length > 0 ? next : [{ id: newId(), title: "New chat", turns: [] }];
      if (id === activeId) {
        setActiveId(list[0].id);
        setTurns(list[0].turns);
      }
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list.map((c) => ({ ...c, turns: lightweightTurns(c.turns) }))));
      } catch {
        /* ignore */
      }
      return list;
    });
  }

  // Append/replace the last assistant turn's parts as the stream arrives.
  function patchAssistant(mut: (parts: Part[]) => Part[]) {
    setTurns((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (!last || last.role !== "assistant") return copy;
      copy[copy.length - 1] = { role: "assistant", parts: mut(last.parts) };
      return copy;
    });
  }

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setInput("");

    const history = [...turns, { role: "user" as const, parts: [{ kind: "text" as const, text: msg }] }];
    setTurns([...history, { role: "assistant", parts: [] }]);

    // Flatten turns to simple {role, content} for the API.
    const apiMessages = history.map((t) => ({
      role: t.role,
      content: t.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""),
    }));

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, model: modelId || undefined }),
      });
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const lines = evt.split("\n");
          const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const dl = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (!ev || !dl) continue;
          const data = JSON.parse(dl);

          if (ev === "token") {
            patchAssistant((parts) => {
              const copy = [...parts];
              const last = copy[copy.length - 1];
              if (last && last.kind === "text") {
                copy[copy.length - 1] = { kind: "text", text: last.text + data };
              } else {
                copy.push({ kind: "text", text: data });
              }
              return copy;
            });
          } else if (ev === "tool_call") {
            patchAssistant((parts) => [...parts, { kind: "tool", name: data.name, args: data.args }]);
          } else if (ev === "tool_result") {
            patchAssistant((parts) => {
              const copy = [...parts];
              for (let i = copy.length - 1; i >= 0; i--) {
                const p = copy[i];
                if (p.kind === "tool" && p.name === data.name && p.result === undefined) {
                  copy[i] = { ...p, result: data.result };
                  break;
                }
              }
              return copy;
            });
          } else if (ev === "image") {
            patchAssistant((parts) => [...parts, { kind: "image", dataUrl: data.dataUrl, model: data.model }]);
          } else if (ev === "error") {
            patchAssistant((parts) => [...parts, { kind: "text", text: `\n\n⚠ ${data.message}` }]);
          }
        }
      }
    } catch (e) {
      patchAssistant((parts) => [...parts, { kind: "text", text: `\n\n⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  return <PageView
    models={models} modelId={modelId} setModelId={setModelId}
    health={health} isPrivate={isPrivate}
    turns={turns} input={input} setInput={setInput} busy={busy} send={send}
    endRef={endRef}
    conversations={conversations} activeId={activeId}
    newChat={newChat} selectChat={selectChat} deleteChat={deleteChat}
  />;
}

function ToolChip({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const label = TOOL_LABEL[part.name] ?? part.name;
  const done = part.result !== undefined;
  const target =
    (part.args.address as string) || (part.args.token as string) || (part.args.holder as string) || "";
  const short = target ? `${target.slice(0, 6)}…${target.slice(-4)}` : "";
  return (
    <div className={`tool ${done ? "done" : "running"}`}>
      <span className="tool-dot" />
      <span className="tool-name">{label}</span>
      {short && <span className="tool-arg">{short}</span>}
      {done ? <span className="tool-status">✓ live</span> : <span className="tool-status">…</span>}
    </div>
  );
}

interface ViewProps {
  models: ModelOption[];
  modelId: string;
  setModelId: (v: string) => void;
  health: Health | null;
  isPrivate: boolean;
  turns: Turn[];
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  send: (t: string) => void;
  endRef: React.RefObject<HTMLDivElement | null>;
  conversations: Conversation[];
  activeId: string;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
}

function PageView(p: ViewProps) {
  const empty = p.turns.length === 0;
  const walletChip = p.health?.wallet
    ? `$${p.health.wallet.balanceUsd?.toFixed?.(2) ?? p.health.wallet.balanceUsd}`
    : null;

  const composer = (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        p.send(p.input);
      }}
    >
      <input
        type="text"
        placeholder={p.isPrivate ? "Ask privately (no live reads)…" : "Ask about any wallet, token, or contract…"}
        value={p.input}
        onChange={(e) => p.setInput(e.target.value)}
        disabled={p.busy}
        spellCheck={false}
      />
      <button type="submit" className="send-btn" disabled={p.busy || !p.input.trim()} aria-label="Send">
        {p.busy ? <span className="spinner" /> : "↑"}
      </button>
    </form>
  );

  const footLine = p.health?.ok ? (
    <div className="composer-foot">
      <span>
        everything via <b>x402</b> (USDC on Base or Solana) ·{" "}
        {p.isPrivate ? "encrypted, no tools" : "live tools + web"}
      </span>
    </div>
  ) : null;

  return (
    <div className="shell">
      {/* ── Sidebar: conversation history ──────────────────────── */}
      <aside className="sidebar">
        <button className="new-chat" onClick={p.newChat} disabled={p.busy}>
          <span className="plus">+</span> New chat
        </button>
        <div className="convo-list">
          {p.conversations.map((c) => (
            <div
              key={c.id}
              className={`convo ${c.id === p.activeId ? "active" : ""}`}
              onClick={() => p.selectChat(c.id)}
              title={c.title}
            >
              <span className="convo-title">{c.title || "New chat"}</span>
              <button
                className="convo-del"
                onClick={(e) => {
                  e.stopPropagation();
                  p.deleteChat(c.id);
                }}
                aria-label="Delete conversation"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <img className="sidebar-logo" src="/venice-light.svg" alt="Venice" />
        </div>
      </aside>

      {/* ── Main app column ────────────────────────────────────── */}
      <div className={`app ${empty ? "is-empty" : ""}`}>
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo" src="/venice-light.svg" alt="Venice" />
            <span className="brand-name">On-Chain Agent</span>
          </div>
          <div className="topbar-right">
            {walletChip && (
              <span
                className={`pill ${p.health?.wallet?.canConsume ? "ok" : "warn"}`}
                title="x402 spendable balance · top up with USDC on Base or Solana"
              >
                x402 · {walletChip}
              </span>
            )}
            <div className="select-wrap">
              <select
                className="bare-select"
                value={p.modelId}
                onChange={(e) => p.setModelId(e.target.value)}
                disabled={p.busy}
                aria-label="Model"
              >
                <optgroup label="Web — live tools + search">
                  {p.models.filter((m) => m.mode === "web").map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Private — E2EE, no tools">
                  {p.models.filter((m) => m.mode === "private").map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              </select>
              <span className="select-caret">▾</span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Conversation ───────────────────────────────────────── */}
      <main className="conversation">
        {empty ? (
          <div className="hero">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="hero-logo" src="/venice-light.svg" alt="Venice" />
            <h1 className="hero-title">On-Chain Agent</h1>
            <p className="hero-sub">
              Reads the chain live with Venice Crypto RPC tools and web search.
              Ask about any wallet, token, or contract.
            </p>
            <span className={`mode-tag ${p.isPrivate ? "priv" : "web"}`}>
              {p.isPrivate ? "🔒 Private E2EE · no live tools" : "🌐 Live on-chain tools + web search"}
            </span>
            <div className="hero-composer">{composer}</div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="suggestion" onClick={() => p.send(s.prompt)} disabled={p.busy}>
                  <span className="sg-icon">{s.icon}</span>
                  <span className="sg-text">
                    <span className="sg-title">{s.title}</span>
                    <span className="sg-hint">{s.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {p.turns.map((t, i) => (
              <div key={i} className={`row ${t.role}`}>
                {t.role === "user" ? (
                  <div className="bubble user">
                    {t.parts.map((part, j) => (part.kind === "text" ? <span key={j}>{part.text}</span> : null))}
                  </div>
                ) : (
                  <div className="assistant-block">
                    {t.parts.map((part, j) =>
                      part.kind === "tool" ? (
                        <ToolChip key={j} part={part} />
                      ) : part.kind === "image" ? (
                        <figure key={j} className="gen-image">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={part.dataUrl} alt="Generated by Venice" />
                          <figcaption>Generated via Venice image API · {part.model} · paid with x402</figcaption>
                        </figure>
                      ) : part.kind === "text" && part.text ? (
                        <Markdown key={j}>{part.text}</Markdown>
                      ) : null,
                    )}
                    {t.parts.length === 0 && <span className="thinking">Thinking…</span>}
                  </div>
                )}
              </div>
            ))}
            <div ref={p.endRef} />
          </div>
        )}
      </main>

      {/* ── Composer (bottom-docked once a chat has started) ────── */}
      {!empty && (
        <footer className="composer-bar">
          {composer}
          {footLine}
        </footer>
      )}
      </div>
    </div>
  );
}
