import { NextRequest, NextResponse } from 'next/server';
import { buildWorkflow } from '@/lib/workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import { prisma } from '@/lib/prisma';
import type { GenerationParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  function bad(message: string) {
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (typeof params.checkpoint !== 'string' || params.checkpoint.length === 0) {
    return bad('checkpoint must be a non-empty string');
  }
  if (!Array.isArray(params.loras)) {
    return bad('loras must be an array');
  }
  for (const lora of params.loras) {
    if (typeof lora?.name !== 'string' || lora.name.length === 0) {
      return bad('each lora must have a non-empty name');
    }
    if (typeof lora.weight !== 'number' || !Number.isFinite(lora.weight)) {
      return bad('each lora must have a numeric weight');
    }
  }
  if (typeof params.positivePrompt !== 'string') return bad('positivePrompt must be a string');
  if (typeof params.negativePrompt !== 'string') return bad('negativePrompt must be a string');
  if (!Number.isInteger(params.width) || params.width < 64 || params.width > 4096) {
    return bad('width must be an integer between 64 and 4096');
  }
  if (!Number.isInteger(params.height) || params.height < 64 || params.height > 4096) {
    return bad('height must be an integer between 64 and 4096');
  }
  if (!Number.isInteger(params.steps) || params.steps < 1 || params.steps > 200) {
    return bad('steps must be an integer between 1 and 200');
  }
  if (typeof params.cfg !== 'number' || !Number.isFinite(params.cfg) || params.cfg < 0 || params.cfg > 30) {
    return bad('cfg must be a number between 0 and 30');
  }
  if (typeof params.seed !== 'number' || !Number.isInteger(params.seed)) {
    return bad('seed must be an integer (use -1 for random)');
  }
  if (typeof params.sampler !== 'string' || params.sampler.length === 0) {
    return bad('sampler must be a non-empty string');
  }
  if (typeof params.scheduler !== 'string' || params.scheduler.length === 0) {
    return bad('scheduler must be a non-empty string');
  }
  if (!Number.isInteger(params.batchSize) || params.batchSize < 1 || params.batchSize > 8) {
    return bad('batchSize must be an integer between 1 and 8');
  }

  // Validate mask payload
  if (params.mask) {
    if (typeof params.mask !== 'string' || params.mask.length === 0) {
      return Response.json({ error: 'mask must be a non-empty base64 string' }, { status: 400 });
    }
    if (!params.baseImage) {
      return Response.json({ error: 'mask requires baseImage to also be set' }, { status: 400 });
    }
    const decodedSize = Math.floor(params.mask.length * 0.75);
    if (decodedSize > 8 * 1024 * 1024) {
      return Response.json({ error: 'mask too large (over 8MB decoded)' }, { status: 400 });
    }
  }

  // Validate referenceImages payload before touching anything else
  if (params.referenceImages) {
    const refs = params.referenceImages;
    if (!Array.isArray(refs.images) || refs.images.length === 0 || refs.images.length > 3) {
      return Response.json({ error: 'referenceImages.images must be 1-3 entries' }, { status: 400 });
    }
    for (const b64 of refs.images) {
      if (typeof b64 !== 'string' || b64.length === 0) {
        return Response.json({ error: 'each reference image must be a non-empty base64 string' }, { status: 400 });
      }
      if (b64.startsWith('data:')) {
        return Response.json({ error: 'reference images must be base64 only, no data: prefix' }, { status: 400 });
      }
      const decodedSize = Math.floor(b64.length * 0.75);
      if (decodedSize < 100 * 1024) {
        return Response.json({ error: 'reference image too small (under 100KB decoded)' }, { status: 400 });
      }
      if (decodedSize > 8 * 1024 * 1024) {
        return Response.json({ error: 'reference image too large (over 8MB decoded)' }, { status: 400 });
      }
    }
    if (typeof refs.strength !== 'number' || refs.strength < 0 || refs.strength > 1.5) {
      return Response.json({ error: 'referenceImages.strength must be 0.0-1.5' }, { status: 400 });
    }
  }

  // Validate projectId if provided
  if (params.projectId !== undefined && params.projectId !== null) {
    if (typeof params.projectId !== 'string' || params.projectId.length === 0) {
      return bad('projectId must be a non-empty string when provided');
    }
    const project = await prisma.project.findUnique({ where: { id: params.projectId } });
    if (!project) {
      return bad('projectId does not reference an existing project');
    }
  }

  // Assemble final prompts server-side; original user prompts go to DB/filename
  const positiveParts: string[] = [];
  const negativeParts: string[] = [];

  // 1. Checkpoint defaults
  if (params.checkpoint) {
    try {
      const ckptConfig = await prisma.checkpointConfig.findUnique({
        where: { checkpointName: params.checkpoint },
      });
      if (ckptConfig?.defaultPositivePrompt) positiveParts.push(ckptConfig.defaultPositivePrompt);
      if (ckptConfig?.defaultNegativePrompt) negativeParts.push(ckptConfig.defaultNegativePrompt);
    } catch { /* non-critical */ }
  }

  // 2. LoRA trigger words (batch fetch, preserve user-specified LoRA order)
  if (params.loras.length > 0) {
    try {
      const loraConfigs = await prisma.loraConfig.findMany({
        where: { loraName: { in: params.loras.map((l) => l.name) } },
      });
      const loraConfigMap = new Map(loraConfigs.map((c) => [c.loraName, c]));
      for (const lora of params.loras) {
        const cfg = loraConfigMap.get(lora.name);
        if (cfg?.triggerWords) positiveParts.push(cfg.triggerWords);
      }
    } catch { /* non-critical */ }
  }

  // 3. User prompts
  if (params.positivePrompt) positiveParts.push(params.positivePrompt);
  if (params.negativePrompt) negativeParts.push(params.negativePrompt);

  const finalPositive = positiveParts.join(', ');
  const finalNegative = negativeParts.join(', ');

  const workflowParams: GenerationParams = {
    ...params,
    positivePrompt: finalPositive,
    negativePrompt: finalNegative,
  };

  const manager = getComfyWSManager();
  const { workflow, resolvedSeed } = buildWorkflow(workflowParams);

  // Disk-avoidance constraint — see CLAUDE.md. SaveImage and LoadImage write to VM disk.
  for (const [nodeId, node] of Object.entries(workflow)) {
    const ct = (node as { class_type: string }).class_type;
    if (ct === 'SaveImage' || ct === 'LoadImage') {
      console.error(`[generate] FORBIDDEN class_type "${ct}" in node ${nodeId}`);
      return Response.json(
        { error: `Internal error: workflow contains forbidden class_type "${ct}". This is a bug.` },
        { status: 500 },
      );
    }
  }

  let comfyRes: Response;
  try {
    comfyRes = await fetch(`${COMFYUI}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: manager.getClientId() }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `ComfyUI unreachable: ${String(err)}` },
      { status: 502 },
    );
  }

  if (!comfyRes.ok) {
    const body = await comfyRes.text();
    return NextResponse.json({ error: body }, { status: comfyRes.status });
  }

  const { prompt_id: promptId } = await comfyRes.json() as { prompt_id: string };
  if (!promptId) {
    return NextResponse.json({ error: 'No prompt_id in ComfyUI response' }, { status: 500 });
  }

  // Strip large fields not needed in finalizeImageJob:
  //   referenceImages / mask  — potentially several MB of base64
  //   baseImage / denoise     — not needed after workflow is built
  const { referenceImages: _ri, mask: _mk, baseImage: _bi, denoise: _d, ...paramsForJob } = params;

  const sseEncoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sseEncoder.encode(`event: init\ndata: ${JSON.stringify({ promptId, resolvedSeed })}\n\n`),
      );

      manager.registerJob(
        promptId,
        paramsForJob as GenerationParams,
        resolvedSeed,
        finalPositive,
        finalNegative,
        controller,
      );

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

  return new Response(stream, { headers: SSE_HEADERS });
}
