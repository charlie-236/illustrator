/**
 * LoRAs whose filename matches this pattern are system-managed and should
 * never appear in user-facing UI. The IP-Adapter Plus custom node requires
 * its companion LoRA file to live in /models/loras/ so ComfyUI can find it,
 * but the Unified Loader uses it internally — users should never select it.
 */
const SYSTEM_LORA_PATTERN = /ip-adapter|wan22-lightning-/i;

export function isSystemLora(loraName: string): boolean {
  return SYSTEM_LORA_PATTERN.test(loraName);
}

export function filterSystemLoras<T extends string | { loraName: string }>(items: T[]): T[] {
  return items.filter((item) => {
    const name = typeof item === 'string' ? item : item.loraName;
    return !isSystemLora(name);
  });
}

