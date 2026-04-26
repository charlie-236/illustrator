export interface ParsedCivitaiUrl {
  parentUrlId: number;
  modelId: number;
}

export function parseCivitaiUrl(input: string): ParsedCivitaiUrl | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'URL is empty' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'Not a valid URL' };
  }

  if (!url.hostname.endsWith('civitai.com')) {
    return { error: 'URL must be a civitai.com link' };
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

  return { parentUrlId, modelId };
}
