/**
 * Resolve the output directory for a generation row based on its media type.
 *
 * Image rows live in IMAGE_OUTPUT_DIR.
 * Stitched video rows live in STITCH_OUTPUT_DIR.
 * Source video clips live in VIDEO_OUTPUT_DIR.
 *
 * Each branch falls back through the other env vars so the helper degrades
 * gracefully when a user hasn't split their output dirs (all three pointing
 * at the same path is a valid configuration).
 */
export function dirForGeneration(g: { mediaType: string; isStitched: boolean }): string {
  if (g.mediaType === 'image') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
