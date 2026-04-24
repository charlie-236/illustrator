import { NextRequest, NextResponse } from 'next/server';
import { buildWorkflow, extractSeedFromWorkflow } from '@/lib/workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import type { GenerationParams } from '@/types';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://localhost:8188';

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const manager = getComfyWSManager();
  const workflow = buildWorkflow(params);
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
