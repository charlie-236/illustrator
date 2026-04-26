import { NextRequest } from 'next/server';
import { ingestModel, type IngestRequest } from '@/lib/civitaiIngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

const encoder = new TextEncoder();

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface BatchItem extends IngestRequest {
  clientId: string;
}

export async function POST(req: NextRequest) {
  let body: { items: BatchItem[] };
  try {
    body = await req.json() as { items: BatchItem[] };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return new Response(JSON.stringify({ error: 'items must be a non-empty array' }), { status: 400 });
  }

  if (body.items.length > 20) {
    return new Response(JSON.stringify({ error: 'Batch size cannot exceed 20 items' }), { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let succeeded = 0;
      let failed = 0;

      try {
        for (const item of body.items) {
          if (
            (item.type !== 'checkpoint' && item.type !== 'lora') ||
            !Number.isFinite(item.modelId) ||
            !Number.isFinite(item.parentUrlId)
          ) {
            controller.enqueue(sseChunk('item', {
              clientId: item.clientId,
              phase: 'error',
              message: 'Invalid item payload',
            }));
            failed++;
            continue;
          }

          for await (const event of ingestModel(item)) {
            controller.enqueue(sseChunk('item', { clientId: item.clientId, ...event }));
            if (event.phase === 'done') { succeeded++; break; }
            if (event.phase === 'error') { failed++; break; }
          }
        }

        controller.enqueue(sseChunk('summary', { succeeded, failed, total: body.items.length }));
      } catch (err) {
        controller.enqueue(sseChunk('fatal', { message: String(err) }));
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
