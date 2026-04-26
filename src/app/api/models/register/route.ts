import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

interface CivitAIMetadata {
  id?: number;
  name?: string;
  trainedWords?: string[];
  baseModel?: string;
  description?: string | null;
  model?: {
    name?: string;
    description?: string | null;
  };
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  const { filename, type, modelId, parentUrlId, civitaiMetadata = {} } = body;

  if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });
  if (type !== 'checkpoint' && type !== 'lora') {
    return NextResponse.json({ error: "type must be 'checkpoint' or 'lora'" }, { status: 400 });
  }

  const friendlyName = (civitaiMetadata.model?.name ?? civitaiMetadata.name ?? '').trim();
  const triggerWords = (civitaiMetadata.trainedWords ?? []).join(', ');
  const baseModel = (civitaiMetadata.baseModel ?? '').trim();
  const description = stripHtml(civitaiMetadata.model?.description ?? civitaiMetadata.description) || null;
  const url = parentUrlId && modelId
    ? `https://civitai.com/models/${parentUrlId}?modelVersionId=${modelId}`
    : null;

  try {
    if (type === 'checkpoint') {
      const record = await prisma.checkpointConfig.upsert({
        where: { checkpointName: filename },
        create: {
          checkpointName: filename,
          friendlyName,
          defaultWidth: 512,
          defaultHeight: 512,
          defaultPositivePrompt: '',
          defaultNegativePrompt: '',
          description,
          url,
        },
        update: { friendlyName, description, url },
      });
      return NextResponse.json({ ok: true, record });
    } else {
      const record = await prisma.loraConfig.upsert({
        where: { loraName: filename },
        create: {
          loraName: filename,
          friendlyName,
          triggerWords,
          baseModel,
          description,
          url,
        },
        update: { friendlyName, triggerWords, baseModel, description, url },
      });
      return NextResponse.json({ ok: true, record });
    }
  } catch (err) {
    console.error('[register] DB write failed:', err);
    return NextResponse.json({ error: `DB write failed: ${String(err)}` }, { status: 500 });
  }
}
