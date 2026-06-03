// ─────────────────────────────────────────────────────────────────────────────
// Model catalog for the analyst.
//
// The workshop point: let the user trade privacy for capability.
//
//   • PRIVATE (E2EE): prompt encrypted client-side, runs in a TEE. Maximum
//     privacy, but web search is disabled (it would leak the prompt), so the
//     model reasons only from the on-chain snapshot we give it.
//
//   • WEB (top models): Venice's strongest frontier models with live web search
//     enabled via venice_parameters. They can tell you what a token actually is,
//     current narratives, etc. — at the cost of E2EE.
//
// Names + capabilities come straight from the live /models response
// (model_spec.name is the official display name), so we never show a guessed or
// stale label. We surface a curated shortlist of recognizable web models plus
// every available E2EE model.
// ─────────────────────────────────────────────────────────────────────────────

export type ModelMode = "private" | "web";

export interface ModelOption {
  id: string;
  label: string; // the real Venice display name (model_spec.name)
  mode: ModelMode;
  reasoning: boolean;
  note: string;
}

interface LiveModel {
  id: string;
  model_spec?: {
    name?: string;
    description?: string;
    model_sets?: string[];
    capabilities?: {
      supportsE2EE?: boolean;
      supportsWebSearch?: boolean;
      supportsReasoning?: boolean;
    };
  };
}

// Recognizable web models to surface first, best-first. We match by id prefix so
// version bumps (claude-opus-4-8 -> 4-9) keep working. Anything not listed is
// still available, just not pinned to the top.
const FEATURED_WEB_PREFIXES = [
  "claude-opus",
  "openai-gpt-55",
  "openai-gpt-54",
  "grok-4",
  "gemini-3",
  "deepseek-v4",
  "kimi-k2",
];

/** Fetch the live text-model catalog (auth headers injected by the caller). */
export async function fetchLiveModels(
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<LiveModel[]> {
  const res = await fetch(`${baseUrl}/models?type=text`, { headers: authHeaders });
  if (!res.ok) throw new Error(`/models failed: ${res.status}`);
  const json = (await res.json()) as { data?: LiveModel[] };
  return json.data ?? [];
}

function displayName(m: LiveModel): string {
  return m.model_spec?.name || m.id;
}

/** Build the picker catalog from the live models response. */
export function buildCatalog(models: LiveModel[]): ModelOption[] {
  const privateOpts: ModelOption[] = [];
  const webFeatured: ModelOption[] = [];

  for (const m of models) {
    const caps = m.model_spec?.capabilities ?? {};
    const reasoning = Boolean(caps.supportsReasoning);

    if (caps.supportsE2EE) {
      privateOpts.push({
        id: m.id,
        label: displayName(m),
        mode: "private",
        reasoning,
        note: reasoning ? "Private E2EE · reasoning" : "Private E2EE",
      });
    } else {
      // Only feature recognizable top web models, best-first by prefix order.
      const rank = FEATURED_WEB_PREFIXES.findIndex((p) => m.id.startsWith(p));
      if (rank >= 0) {
        webFeatured.push({
          id: m.id,
          label: displayName(m),
          mode: "web",
          reasoning,
          note: "Live web search",
          // stash rank for sorting via a non-enumerable trick: use a temp field
        } as ModelOption & { _rank?: number });
        (webFeatured[webFeatured.length - 1] as ModelOption & { _rank?: number })._rank = rank;
      }
    }
  }

  // Sort private: reasoning models first, then by name.
  privateOpts.sort((a, b) => Number(b.reasoning) - Number(a.reasoning) || a.label.localeCompare(b.label));

  // Sort web by featured rank, then name; dedupe by keeping the first (newest) per prefix.
  webFeatured.sort(
    (a, b) =>
      ((a as { _rank?: number })._rank ?? 99) - ((b as { _rank?: number })._rank ?? 99) ||
      b.label.localeCompare(a.label),
  );
  const seenPrefix = new Set<number>();
  const webOpts: ModelOption[] = [];
  for (const o of webFeatured) {
    const rank = (o as { _rank?: number })._rank ?? 99;
    if (seenPrefix.has(rank)) continue; // one per featured family
    seenPrefix.add(rank);
    delete (o as { _rank?: number })._rank;
    webOpts.push(o);
  }

  return [...privateOpts, ...webOpts];
}

/** Is a given model id one of the private (E2EE) options? */
export function isPrivateModel(id: string): boolean {
  return id.startsWith("e2ee-");
}
