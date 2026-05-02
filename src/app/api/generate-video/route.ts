import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { buildT2VWorkflow, buildI2VWorkflow, WAN22_DEFAULT_NEGATIVE_PROMPT } from '@/lib/wan22-workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import type { ComfyWorkflow } from '@/lib/wan22-workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';

interface VideoRequest {
  mode: 't2v' | 'i2v';
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed?: number;
  startImageB64?: string;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Video runtime guard — parallel to /api/generate's image guard.
// SaveWEBM is the explicit exception allowed only in the video path.
function validateVideoWorkflow(wf: ComfyWorkflow): void {
  for (const [nodeId, node] of Object.entries(wf)) {
    const cls = node.class_type;
    if (cls === 'SaveImage') throw new Error(`SaveImage forbidden (node ${nodeId})`);
    if (cls === 'LoadImage') throw new Error(`LoadImage forbidden — use ETN_LoadImageBase64 (node ${nodeId})`);
    if (cls === 'SaveAnimatedWEBP') throw new Error(`SaveAnimatedWEBP should have been stripped (node ${nodeId})`);
  }
}

export async function POST(req: NextRequest) {
  const outputDir = process.env.IMAGE_OUTPUT_DIR;
  if (!outputDir) {
    return new Response(
      JSON.stringify({ error: 'IMAGE_OUTPUT_DIR is not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let body: VideoRequest;
  try {
    body = await req.json() as VideoRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  // ─── validation ───────────────────────────────────────────────────────────

  const { mode, prompt, negativePrompt, width, height, frames, steps, cfg, startImageB64 } = body;

  if (mode !== 't2v' && mode !== 'i2v') {
    return new Response(JSON.stringify({ error: "mode must be 't2v' or 'i2v'" }), { status: 400 });
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'prompt must be a non-empty string' }), { status: 400 });
  }
  if (!Number.isInteger(width) || width < 256 || width > 1280 || width % 32 !== 0) {
    return new Response(JSON.stringify({ error: 'width must be an integer multiple of 32, 256–1280 inclusive' }), { status: 400 });
  }
  if (!Number.isInteger(height) || height < 256 || height > 1280 || height % 32 !== 0) {
    return new Response(JSON.stringify({ error: 'height must be an integer multiple of 32, 256–1280 inclusive' }), { status: 400 });
  }
  if (!Number.isInteger(frames) || frames < 17 || frames > 121 || (frames - 1) % 8 !== 0) {
    return new Response(JSON.stringify({ error: 'frames must be an integer satisfying (frames-1) % 8 === 0, range 17–121 (e.g. 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121)' }), { status: 400 });
  }
  if (!Number.isInteger(steps) || steps < 4 || steps > 40 || steps % 2 !== 0) {
    return new Response(JSON.stringify({ error: 'steps must be an even integer, 4–40 inclusive' }), { status: 400 });
  }
  if (typeof cfg !== 'number' || !Number.isFinite(cfg) || cfg < 1.0 || cfg > 10.0) {
    return new Response(JSON.stringify({ error: 'cfg must be a number 1.0–10.0 inclusive' }), { status: 400 });
  }
  if (mode === 'i2v' && !startImageB64) {
    return new Response(JSON.stringify({ error: "startImageB64 is required for mode='i2v'" }), { status: 400 });
  }
  if (mode === 't2v' && startImageB64) {
    return new Response(JSON.stringify({ error: "startImageB64 is not allowed for mode='t2v'" }), { status: 400 });
  }

  // ─── prepare ──────────────────────────────────────────────────────────────

  const seed = typeof body.seed === 'number' && Number.isInteger(body.seed)
    ? body.seed
    : Math.floor(Math.random() * 2 ** 32);

  const generationId = uuidv4();
  const filenamePrefix = randomBytes(8).toString('hex'); // 16 hex chars, ~64 bits entropy

  const videoParams = {
    generationId,
    filenamePrefix,
    prompt: prompt.trim(),
    negativePrompt:
      negativePrompt && negativePrompt.trim().length > 0
        ? negativePrompt
        : WAN22_DEFAULT_NEGATIVE_PROMPT,
    width,
    height,
    frames,
    steps,
    cfg,
    seed,
    mode,
    outputDir,
  } as const;

  let workflow: ComfyWorkflow;
  try {
    if (mode === 'i2v') {
      workflow = buildI2VWorkflow({ ...videoParams, startImageB64: startImageB64! });
    } else {
      workflow = buildT2VWorkflow(videoParams);
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: `Workflow build error: ${String(err)}` }), { status: 500 });
  }

  // Video runtime guard — SaveWEBM allowed; SaveImage/LoadImage/SaveAnimatedWEBP forbidden
  try {
    validateVideoWorkflow(workflow);
  } catch (err) {
    console.error('[generate-video] FORBIDDEN node in workflow:', err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${String(err)}. This is a bug.` }),
      { status: 500 },
    );
  }

  // ─── submit to ComfyUI ────────────────────────────────────────────────────

  const manager = getComfyWSManager();

  let comfyRes: Response;
  try {
    comfyRes = await fetch(`${COMFYUI}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: manager.getClientId() }),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `ComfyUI unreachable: ${String(err)}` }),
      { status: 502 },
    );
  }

  if (!comfyRes.ok) {
    const body = await comfyRes.text();
    return new Response(JSON.stringify({ error: body }), { status: comfyRes.status });
  }

  const { prompt_id: promptId } = await comfyRes.json() as { prompt_id: string };
  if (!promptId) {
    return new Response(JSON.stringify({ error: 'No prompt_id in ComfyUI response' }), { status: 500 });
  }

  // ─── SSE stream ───────────────────────────────────────────────────────────

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      manager.registerVideoJob(promptId, videoParams, controller);

      req.signal.addEventListener('abort', () => {
        manager.removeJob(promptId);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      manager.removeJob(promptId);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
