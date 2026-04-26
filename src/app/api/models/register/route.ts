import { NextRequest, NextResponse } from 'next/server';
import { registerModel } from '@/lib/registerModel';
import type { CivitAIMetadata } from '@/lib/registerModel';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: {
    filename: string;
    type: string;
    modelId?: string | number;
    parentUrlId?: string | number;
    civitaiMetadata?: CivitAIMetadata;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { filename, type, modelId, parentUrlId, civitaiMetadata } = body;

  if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });
  if (type !== 'checkpoint' && type !== 'lora') {
    return NextResponse.json({ error: "type must be 'checkpoint' or 'lora'" }, { status: 400 });
  }

  const result = await registerModel({
    filename,
    type,
    modelId: modelId != null ? Number(modelId) : undefined,
    parentUrlId: parentUrlId != null ? Number(parentUrlId) : undefined,
    civitaiMetadata,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, record: result.record });
}
