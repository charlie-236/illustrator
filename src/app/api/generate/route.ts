import { NextRequest, NextResponse } from 'next/server';
import { buildWorkflow, extractSeedFromWorkflow } from '@/lib/workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import { prisma } from '@/lib/prisma';
import type { GenerationParams } from '@/types';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://localhost:8188';

async function uploadBaseImage(dataUrl: string): Promise<string | undefined> {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return undefined;
    const meta = dataUrl.slice(0, commaIdx); // e.g. "data:image/jpeg;base64"
    const base64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = meta.match(/^data:([^;]+)/);
    const mimeType = mimeMatch?.[1] ?? 'image/jpeg';
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';

    const imageBuffer = Buffer.from(base64, 'base64');
    const blob = new Blob([imageBuffer], { type: mimeType });

    const form = new FormData();
    form.append('image', blob, `upload.${ext}`);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const res = await fetch(`${COMFYUI}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) return undefined;
    const data = await res.json() as { name: string; subfolder?: string };
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Upload base image to ComfyUI before building the workflow
  let uploadedFilename: string | undefined;
  if (params.baseImage) {
    uploadedFilename = await uploadBaseImage(params.baseImage);
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
  const workflow = buildWorkflow(workflowParams, uploadedFilename);
  const resolvedSeed = extractSeedFromWorkflow(workflow as Record<string, unknown>);

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
  manager.stashJobParams(promptId, params, resolvedSeed);

  return NextResponse.json({ promptId, resolvedSeed });
}
