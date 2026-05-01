import { NextResponse } from 'next/server';
import { filterSystemLoras } from '@/lib/systemLoraFilter';
import { prisma } from '@/lib/prisma';

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

export async function GET() {
  try {
    const [checkpoints, loras, embeddingRows] = await Promise.all([
      getNodeInputList('CheckpointLoaderSimple', 'ckpt_name'),
      getNodeInputList('LoraLoader', 'lora_name'),
      prisma.embeddingConfig.findMany({
        select: { embeddingName: true },
        orderBy: { embeddingName: 'asc' },
      }),
    ]);
    return NextResponse.json({
      checkpoints,
      loras: filterSystemLoras(loras),
      embeddings: embeddingRows.map((e) => e.embeddingName),
    });
  } catch (err) {
    console.error('[/api/models]', err);
    return NextResponse.json(
      { error: 'Failed to reach ComfyUI', checkpoints: [], loras: [], embeddings: [] },
      { status: 502 },
    );
  }
}
