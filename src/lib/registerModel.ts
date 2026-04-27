import { prisma } from '@/lib/prisma';

export interface CivitAIMetadata {
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

export interface RegisterModelInput {
  filename: string;
  type: 'checkpoint' | 'lora';
  modelId?: number;
  parentUrlId?: number;
  civitaiMetadata?: CivitAIMetadata;
  sourceHostname?: string;
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

export interface RegisteredModelInfo {
  id: string;
  friendlyName: string;
  baseModel: string;
  triggerWords: string;
}

export async function registerModel(
  input: RegisterModelInput,
): Promise<{ ok: true; record: RegisteredModelInfo } | { ok: false; error: string }> {
  const { filename, type, modelId, parentUrlId, civitaiMetadata = {} } = input;

  const friendlyName = (civitaiMetadata.model?.name ?? civitaiMetadata.name ?? '').trim();
  const triggerWords = (civitaiMetadata.trainedWords ?? []).join(', ');
  const baseModel = (civitaiMetadata.baseModel ?? '').trim();
  const description = stripHtml(civitaiMetadata.model?.description ?? civitaiMetadata.description) || null;
  // Preserve the source domain (civitai.red vs civitai.com) from the user's original URL input
  const host = input.sourceHostname ?? 'civitai.com';
  const url =
    parentUrlId != null && modelId != null
      ? `https://${host}/models/${parentUrlId}?modelVersionId=${modelId}`
      : null;

  try {
    if (type === 'checkpoint') {
      const record = await prisma.checkpointConfig.upsert({
        where: { checkpointName: filename },
        create: {
          checkpointName: filename,
          friendlyName,
          defaultWidth: 1024,
          defaultHeight: 1024,
          defaultPositivePrompt: '',
          defaultNegativePrompt: '',
          description,
          url,
        },
        update: { friendlyName, description, url },
      });
      return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
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
      return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
    }
  } catch (err) {
    console.error('[registerModel] DB write failed:', err);
    return { ok: false, error: `DB write failed: ${String(err)}` };
  }
}
