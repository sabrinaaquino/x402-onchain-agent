import { veniceFromEnv } from "@/lib/venice/client";
import { fetchAndVerifyAttestation } from "@/lib/venice/e2ee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/attestation
 * Fetches + verifies the TEE attestation for the configured E2EE model.
 * Great for the "Venice E2EE" slide: show the live attested enclave + signer
 * address before running the demo.
 */
export async function GET() {
  try {
    const client = veniceFromEnv();
    const authHeaders = await client.authHeadersFor(`${client.config.baseUrl}/tee/attestation`);
    const ctx = await fetchAndVerifyAttestation(
      client.config.baseUrl,
      client.config.e2eeModel,
      authHeaders,
    );
    return Response.json({
      ok: true,
      model: client.config.e2eeModel,
      verified: ctx.verified,
      teeProvider: ctx.teeProvider,
      signingAddress: ctx.signingAddress,
      modelPublicKeyPreview: ctx.modelPublicKey.slice(0, 18) + "…",
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
