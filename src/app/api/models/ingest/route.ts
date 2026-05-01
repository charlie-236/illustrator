import { NextRequest } from 'next/server';
import { ingestModel, type IngestRequest } from '@/lib/civitaiIngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const encoder = new TextEncoder();

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: NextRequest) {
  let body: IngestRequest;
  try {
    body = await req.json() as IngestRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (body.type !== 'checkpoint' && body.type !== 'lora' && body.type !== 'embedding') {
    return new Response(JSON.stringify({ error: "type must be 'checkpoint', 'lora', or 'embedding'" }), { status: 400 });
  }
  if (!Number.isFinite(body.modelId) || !Number.isFinite(body.parentUrlId)) {
    return new Response(JSON.stringify({ error: 'modelId and parentUrlId must be numbers' }), { status: 400 });
  }
  // sourceHostname is optional; only passed when the user's input URL used a non-default domain
  if (body.sourceHostname !== undefined && typeof body.sourceHostname !== 'string') {
    return new Response(JSON.stringify({ error: 'sourceHostname must be a string' }), { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of ingestModel(body)) {
          controller.enqueue(sseChunk(event.phase, event));
          if (event.phase === 'done' || event.phase === 'error') break;
        }
      } catch (err) {
        controller.enqueue(sseChunk('error', { phase: 'error', message: String(err) }));
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
