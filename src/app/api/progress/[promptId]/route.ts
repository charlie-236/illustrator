import { NextRequest } from 'next/server';
import { getComfyWSManager } from '@/lib/comfyws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ promptId: string }> },
) {
  const { promptId } = await params;
  const manager = getComfyWSManager();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      manager.registerJob(promptId, controller);

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
