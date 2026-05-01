import { NextResponse } from 'next/server';
import { filterSystemLoras } from '@/lib/systemLoraFilter';

export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';

async function getNodeInputList(nodeType: string, inputName: string): Promise<string[]> {
  const res = await fetch(`${COMFYUI}/object_info/${nodeType}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return [];
  const data = await res.json() as Record<string, unknown>;
  const node = data[nodeType] as { input?: { required?: Record<string, unknown[]> } } | undefined;
  const list = node?.input?.required?.[inputName]?.[0];
  return Array.isArray(list) ? (list as string[]) : [];
}

async function getEmbeddings(): Promise<string[]> {
  const res = await fetch(`${COMFYUI}/embeddings`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`ComfyUI /embeddings returned ${res.status}`);
  const data = await res.json() as unknown;
  if (!Array.isArray(data)) throw new Error('ComfyUI /embeddings returned unexpected shape');
  return (data as string[]).slice().sort((a, b) => a.localeCompare(b));
}

export async function GET() {
  try {
    const [checkpoints, loras, embeddings] = await Promise.all([
      getNodeInputList('CheckpointLoaderSimple', 'ckpt_name'),
      getNodeInputList('LoraLoader', 'lora_name'),
      getEmbeddings(),
    ]);
    return NextResponse.json({
      checkpoints,
      loras: filterSystemLoras(loras),
      embeddings,
    });
  } catch (err) {
    console.error('[/api/models]', err);
    return NextResponse.json(
      { error: 'Failed to reach ComfyUI', checkpoints: [], loras: [], embeddings: [] },
      { status: 502 },
    );
  }
}
