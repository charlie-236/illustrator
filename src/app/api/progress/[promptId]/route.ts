import { NextRequest } from 'next/server';
import { getComfyWSManager } from '@/lib/comfyws';
import type { GenerationParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { promptId: string } },
) {
  const { promptId } = params;
  const url = new URL(req.url);

  let genParams: GenerationParams;
  try {
    genParams = JSON.parse(url.searchParams.get('params') ?? '{}') as GenerationParams;
  } catch {
    return new Response('Invalid params', { status: 400 });
  }

  const resolvedSeed = parseInt(url.searchParams.get('seed') ?? '-1', 10);
  const manager = getComfyWSManager();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      manager.registerJob(promptId, genParams, resolvedSeed, controller);

      req.signal.addEventListener('abort', () => {
        manager.removeJob(promptId);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
