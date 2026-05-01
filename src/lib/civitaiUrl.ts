export interface ParsedCivitaiInput {
  parentUrlId: number;
  modelId: number;
  /** Canonical URL in the form https://civitai.com/models/<parentId>?modelVersionId=<versionId> */
  canonicalUrl: string;
  /** Type from Air string, if present. Otherwise null. */
  type: 'checkpoint' | 'lora' | 'embedding' | null;
  /** Base model string from Air string (e.g. "sdxl", "sd1"). Otherwise null. */
  baseModel: string | null;
  /** Original hostname when parsed from a URL (for sourceHostname forwarding). */
  hostname: string | null;
}

export function parseCivitaiInput(input: string): ParsedCivitaiInput | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Input is empty' };

  if (trimmed.startsWith('urn:air:')) {
    return parseAirString(trimmed);
  }
  return parseCivitaiUrlInternal(trimmed);
}

// Keep the old name as an alias so existing callers don't need changes.
export const parseCivitaiUrl = parseCivitaiInput;

function parseAirString(input: string): ParsedCivitaiInput | { error: string } {
  const match = input.match(/^urn:air:([^:]+):([^:]+):civitai:(\d+)@(\d+)$/);
  if (!match) {
    return { error: 'Air string format invalid. Expected urn:air:<base>:<type>:civitai:<id>@<id>' };
  }

  const [, baseModel, type, parentIdStr, versionIdStr] = match;
  const parentUrlId = parseInt(parentIdStr, 10);
  const modelId = parseInt(versionIdStr, 10);

  if (!Number.isFinite(parentUrlId) || !Number.isFinite(modelId)) {
    return { error: 'Air string contains invalid IDs' };
  }

  const normalizedType =
    type === 'checkpoint' || type === 'lora' || type === 'embedding' ? type : null;

  return {
    parentUrlId,
    modelId,
    canonicalUrl: `https://civitai.com/models/${parentUrlId}?modelVersionId=${modelId}`,
    type: normalizedType,
    baseModel: baseModel || null,
    hostname: null,
  };
}

function parseCivitaiUrlInternal(input: string): ParsedCivitaiInput | { error: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { error: 'Not a valid URL or Air string' };
  }

  if (!url.hostname.endsWith('civitai.com') && !url.hostname.endsWith('civitai.red')) {
    return { error: 'URL must be a civitai.com or civitai.red link' };
  }

  const pathMatch = url.pathname.match(/^\/models\/(\d+)/);
  if (!pathMatch) return { error: 'URL must include /models/{id}' };
  const parentUrlId = parseInt(pathMatch[1], 10);

  const versionParam = url.searchParams.get('modelVersionId');
  if (!versionParam) {
    return { error: 'URL must include ?modelVersionId=... — pick a specific version on CivitAI and copy that URL' };
  }
  const modelId = parseInt(versionParam, 10);

  if (!Number.isFinite(modelId) || !Number.isFinite(parentUrlId)) {
    return { error: 'IDs must be numeric' };
  }

  return {
    parentUrlId,
    modelId,
    canonicalUrl: `https://civitai.com/models/${parentUrlId}?modelVersionId=${modelId}`,
    type: null,
    baseModel: null,
    hostname: url.hostname,
  };
}
