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

      // SSE stream close means the browser disconnected (refresh, tab close, network drop).
      // It does NOT mean the user pressed Abort. The job stays alive on the server so
      // that the next /api/jobs/active poll can reattach. Explicit abort goes through
      // POST /api/jobs/[promptId]/abort instead.
      req.signal.addEventListener('abort', () => {
        manager.removeSubscriber(promptId, controller);
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
