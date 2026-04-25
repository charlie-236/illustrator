import { NextRequest, NextResponse } from 'next/server';
import { buildWorkflow, extractSeedFromWorkflow } from '@/lib/workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import { prisma } from '@/lib/prisma';
import type { GenerationParams } from '@/types';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://localhost:8188';

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
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
  const workflow = buildWorkflow(workflowParams);
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

  // The SSE route will register the job; we return the promptId so the client can subscribe.
  return NextResponse.json({ promptId, resolvedSeed });
}
