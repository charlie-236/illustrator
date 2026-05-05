import type { StoryboardScene } from '@/types';

/**
 * Parses the LLM's [SCENE N] block format into an array of partial scene objects.
 * Returns null if the output cannot be parsed (zero valid scenes).
 *
 * The returned scenes have no `id` or `position` — those are filled in by the route.
 *
 * Parser is defensive:
 * - Strips markdown code fences (```...```) the model might wrap output in.
 * - Case-insensitive key matching (DESCRIPTION / Description / description).
 * - Multi-line values: captures until the next KEY: marker or next [SCENE N] header.
 * - Clamps DURATION to 2-7; defaults to 4 if unparseable.
 * - Returns null only if zero scenes with both DESCRIPTION and PROMPT are found.
 */
export function parseStoryboard(raw: string): Omit<StoryboardScene, 'id' | 'position'>[] | null {
  // 1. Strip leading/trailing whitespace.
  let text = raw.trim();

  // 2. Strip markdown code fences (```text ... ``` or ``` ... ```).
  text = text.replace(/^```[\w]*\n?([\s\S]*?)```\s*$/m, '$1').trim();

  // 3. Split on [SCENE N] markers (case-insensitive, flexible whitespace).
  const scenePattern = /\[SCENE\s+\d+\]/gi;
  const parts = text.split(scenePattern);
  // parts[0] = preamble (often empty), parts[1..N] = scene bodies

  if (parts.length < 2) {
    return null;
  }

  const scenes: Omit<StoryboardScene, 'id' | 'position'>[] = [];

  for (let i = 1; i < parts.length; i++) {
    const body = parts[i].trim();
    if (!body) continue;

    const description = extractField(body, 'description');
    const positivePrompt = extractField(body, 'prompt');
    const durationRaw = extractField(body, 'duration');

    // Skip scenes missing both key fields.
    if (!description && !positivePrompt) continue;

    let durationSeconds = 4;
    if (durationRaw) {
      const parsed = parseInt(durationRaw, 10);
      if (!isNaN(parsed)) {
        durationSeconds = Math.max(2, Math.min(7, parsed));
      }
    }

    scenes.push({
      description: description ?? '',
      positivePrompt: positivePrompt ?? '',
      durationSeconds,
    });
  }

  return scenes.length > 0 ? scenes : null;
}

/**
 * Extracts a field value from a scene body block.
 * Matches KEY: <value> where value can span multiple lines until the next KEY: marker.
 */
function extractField(body: string, key: string): string | null {
  // Match the key (case-insensitive) followed by colon + optional whitespace, then capture
  // everything up to the next ALL-CAPS KEY: line (another field) or end of string.
  const regex = new RegExp(
    `(?:^|\\n)${key}\\s*:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z]+\\s*:|$)`,
    'i',
  );
  const match = body.match(regex);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}
