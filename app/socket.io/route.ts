// Some browser extensions (and other local tools) probe every dev server for a
// Socket.IO endpoint by polling /socket.io?EIO=4&transport=polling. This app does
// NOT use Socket.IO — its streaming is plain SSE (fetch + ReadableStream). Those
// probes would otherwise log a slow 404 on every poll, cluttering the terminal.
//
// We answer them instantly with 204 No Content so the noise disappears. This has
// no effect on the app; it's purely to silence an unrelated external client.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noContent() {
  return new Response(null, { status: 204 });
}

export const GET = noContent;
export const POST = noContent;
