import { prisma } from '@/lib/prisma';

export interface CivitAIMetadata {
  id?: number;
  name?: string;
  trainedWords?: string[];
  baseModel?: string;
  description?: string | null;
  tags?: string[];
  files?: Array<{ name?: string }>;
  model?: {
    name?: string;
    description?: string | null;
    tags?: string[];
  };
}

export interface RegisterModelInput {
  filename: string;
  type: 'checkpoint' | 'lora' | 'embedding';
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

// Normalize CivitAI base model strings to canonical internal values.
// CivitAI returns "Wan Video 2.2", "WanVideo2.2", "Wan2.2", etc. — all map to 'Wan 2.2'.
function normalizeBaseModel(raw: string): string {
  const s = raw.trim();
  if (/wan\s*(?:video\s*)?2\.?2/i.test(s)) return 'Wan 2.2';
  return s;
}

/**
 * Detect whether a Wan 2.2 LoRA file targets the high-noise or low-noise expert
 * based on its CivitAI filename and version name.
 *
 * Returns null when no clear signal is present — caller should keep schema
 * defaults (both true) so non-paired LoRAs retain "applies to both" behavior.
 */
function detectWanExpertScope(meta: CivitAIMetadata): {
  appliesToHigh: boolean;
  appliesToLow: boolean;
} | null {
  const haystack = [
    meta.files?.[0]?.name ?? '',
    meta.name ?? '',
  ].join(' ').toLowerCase();

  const highMatch = /high[\s_-]?noise/.test(haystack);
  const lowMatch  = /low[\s_-]?noise/.test(haystack);

  if (highMatch && !lowMatch) return { appliesToHigh: true,  appliesToLow: false };
  if (lowMatch  && !highMatch) return { appliesToHigh: false, appliesToLow: true };

  return null;
}

function extractCategoryFromTags(meta: CivitAIMetadata): string | null {
  const tags: string[] = meta.tags ?? meta.model?.tags ?? [];
  if (!Array.isArray(tags) || tags.length === 0) return null;

  const lower = tags.map((t) => String(t).toLowerCase());

  if (lower.some((t) => t.includes('negative') || t.includes('quality'))) return 'negative';
  if (lower.some((t) => t === 'style' || t.includes('style'))) return 'style';
  if (lower.some((t) => t === 'character' || t.includes('character'))) return 'character';
  if (lower.some((t) => t === 'concept' || t.includes('concept'))) return 'concept';

  return null;
}

export async function registerModel(
  input: RegisterModelInput,
): Promise<{ ok: true; record: RegisteredModelInfo } | { ok: false; error: string }> {
  const { filename, type, modelId, parentUrlId, civitaiMetadata = {} } = input;

  const friendlyName = (civitaiMetadata.model?.name ?? civitaiMetadata.name ?? '').trim();
  const triggerWords = (civitaiMetadata.trainedWords ?? []).join(', ');
  const baseModel = normalizeBaseModel(civitaiMetadata.baseModel ?? '');
  const description = stripHtml(civitaiMetadata.model?.description ?? civitaiMetadata.description) || null;
  // Preserve the source domain (civitai.red vs civitai.com) from the user's original URL input
  const host = input.sourceHostname ?? 'civitai.com';
  const url =
    parentUrlId != null && modelId != null
      ? `https://${host}/models/${parentUrlId}?modelVersionId=${modelId}`
      : null;

  try {
    if (type === 'checkpoint') {
      const category = extractCategoryFromTags(civitaiMetadata);
      const record = await prisma.checkpointConfig.upsert({
        where: { checkpointName: filename },
        create: {
          checkpointName: filename,
          friendlyName,
          baseModel,
          category,
          defaultWidth: 1024,
          defaultHeight: 1024,
          defaultPositivePrompt: '',
          defaultNegativePrompt: '',
          description,
          url,
        },
        update: { friendlyName, ...(baseModel ? { baseModel } : {}), ...(category ? { category } : {}), description, url },
      });
      return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
    } else if (type === 'lora') {
      const category = extractCategoryFromTags(civitaiMetadata);
      const expertScope = detectWanExpertScope(civitaiMetadata);
      const record = await prisma.loraConfig.upsert({
        where: { loraName: filename },
        create: {
          loraName: filename,
          friendlyName,
          triggerWords,
          baseModel,
          category,
          description,
          url,
          ...(expertScope ?? {}),
        },
        update: {
          friendlyName,
          triggerWords,
          ...(baseModel ? { baseModel } : {}),
          ...(category ? { category } : {}),
          description,
          url,
          ...(expertScope ?? {}),
        },
      });
      return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
    } else {
      const category = extractCategoryFromTags(civitaiMetadata);
      const record = await prisma.embeddingConfig.upsert({
        where: { embeddingName: filename },
        create: {
          embeddingName: filename,
          friendlyName,
          triggerWords,
          baseModel,
          category,
          description,
          url,
        },
        update: {
          friendlyName,
          triggerWords,
          ...(baseModel ? { baseModel } : {}),
          ...(category ? { category } : {}),
          description,
          url,
        },
      });
      return { ok: true, record: { id: record.id, friendlyName, baseModel, triggerWords } };
    }
  } catch (err) {
    console.error('[registerModel] DB write failed:', err);
    return { ok: false, error: `DB write failed: ${String(err)}` };
  }
}
