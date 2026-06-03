import { veniceFromEnv } from "@/lib/venice/client";
import { fetchLiveModels, buildCatalog } from "@/lib/venice/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models
 * Returns the curated model picker options (private E2EE vs web-capable top
 * models), intersected with what's actually live in the Venice catalog.
 */
export async function GET() {
  try {
    const client = veniceFromEnv();
    // /models is listed with the x402 wallet credential like everything else.
    const headers = await client.authHeadersFor(`${client.config.baseUrl}/models`);

    const live = await fetchLiveModels(client.config.baseUrl, headers);
    const options = buildCatalog(live);

    return Response.json({
      ok: true,
      defaultPrivate: client.config.e2eeModel,
      options,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
