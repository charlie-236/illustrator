import { NextRequest, NextResponse } from 'next/server';
import { buildWorkflow } from '@/lib/workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import { prisma } from '@/lib/prisma';
import type { GenerationParams } from '@/types';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
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

  // Stash original params (not workflowParams) so DB stores the user's typed prompts, not the
  // assembled-with-defaults version. The SSE route picks these up via registerJob().
  // finalPositive/finalNegative are recorded alongside for forensic reference.
  // Strip referenceImages (potentially several MB of base64) — not needed in finalizeJob.
  const { referenceImages: _ri, ...paramsForStash } = params;
  manager.stashJobParams(promptId, paramsForStash as GenerationParams, resolvedSeed, finalPositive, finalNegative);

  return NextResponse.json({ promptId, resolvedSeed });
}
