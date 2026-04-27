/**
 * Frozen-token validator.
 *
 * The LLM is instructed to copy weighted/LoRA tokens verbatim, but at
 * temperature > 0 it occasionally drifts (e.g. (eyes:1.5) -> (eyes:1.3)).
 * This validator extracts every frozen token from the user's input and
 * asserts each appears as an exact substring in the LLM's output.
 *
 * Token shapes recognized (must match the prompt's RULE 1):
 *   (word:N)         e.g. (glowing eyes:1.5), (warts:0.7)
 *   ((word))         double-paren emphasis
 *   [[word]]         LoRA / double-bracket trigger
 *
 * Single-bracket [word] is intentionally NOT validated: it is de-emphasis
 * syntax and rarely user-critical. Add to the regex if that changes.
 */

const WEIGHTED_PAREN = /\([^()]+:[0-9]+(?:\.[0-9]+)?\)/g;
const DOUBLE_PAREN = /\(\([^()]+\)\)/g;
const DOUBLE_BRACKET = /\[\[[^\[\]]+\]\]/g;

export function extractFrozenTokens(input: string): string[] {
  const tokens = [
    ...(input.match(WEIGHTED_PAREN) ?? []),
    ...(input.match(DOUBLE_PAREN) ?? []),
    ...(input.match(DOUBLE_BRACKET) ?? []),
  ];
  // De-duplicate while preserving order.
  return Array.from(new Set(tokens));
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; missing: string[] };

export function validatePreservation(
  input: string,
  output: string,
): ValidationResult {
  const required = extractFrozenTokens(input);
  const missing = required.filter((tok) => !output.includes(tok));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
