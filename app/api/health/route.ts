import { veniceFromEnv } from "@/lib/venice/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * Reports which auth mode is active and (in x402 mode) the wallet balance.
 * Used by the UI status bar so presenters can confirm config at a glance.
 */
export async function GET() {
  try {
    const client = veniceFromEnv();
    const out: Record<string, unknown> = {
      ok: true,
      authMode: client.effectiveAuthMode,
      inferenceAuth: client.inferenceAuth,
      rpcAuth: client.rpcAuth,
      e2eeModel: client.config.e2eeModel,
      defaultNetwork: client.config.defaultNetwork,
    };

    // Report the agent wallet's spendable balance when x402 is configured.
    if (client.hasWallet) {
      try {
        const bal = await client.walletBalance();
        out.wallet = {
          address: bal.address,
          balanceUsd: bal.balanceUsd,
          diemBalanceUsd: bal.diemBalanceUsd,
          canConsume: bal.canConsume,
        };
      } catch (e) {
        out.walletError = e instanceof Error ? e.message : String(e);
      }
    }

    return Response.json(out);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
