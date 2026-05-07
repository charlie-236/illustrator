/**
 * UUID-shaped ID generator that works in both secure contexts (HTTPS/localhost)
 * and insecure contexts (HTTP over LAN, e.g. tablet access). crypto.randomUUID
 * is only available in secure contexts; the Math.random fallback is sufficient
 * for client-side dedup IDs where collision risk is negligible.
 */
export function safeRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
