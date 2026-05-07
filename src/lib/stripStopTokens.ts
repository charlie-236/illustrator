const STOP_TOKEN_PATTERNS: RegExp[] = [
  /<\|im_end\|>/g,
  /<\|endoftext\|>/g,
  /<\|eot_id\|>/g,
  /<\|im_start\|>/g,
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<s>/g,
  /<\/s>/g,
];

export function stripStopTokens(text: string): string {
  let cleaned = text;
  for (const pattern of STOP_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}
