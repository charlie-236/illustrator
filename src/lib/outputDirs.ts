/**
 * Resolve the output directory for a generation row based on its media type.
 *
 * Image rows live in IMAGE_OUTPUT_DIR.
 * Stitched video rows live in STITCH_OUTPUT_DIR.
 * Source video clips live in VIDEO_OUTPUT_DIR.
 *
 * Any non-video mediaType (including null, undefined, 'image', or future types)
 * falls into IMAGE_OUTPUT_DIR — defensive default for unknown types.
 *
 * Each non-image branch falls back through the other env vars so the helper
 * degrades gracefully when output dirs aren't split (all three pointing at the
 * same path is a valid configuration).
 */
export function dirForGeneration(g: {
  mediaType?: string | null;
  isStitched?: boolean | null;
}): string {
  if (g.mediaType !== 'video') return process.env.IMAGE_OUTPUT_DIR ?? '';
  if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
  return process.env.VIDEO_OUTPUT_DIR ?? process.env.IMAGE_OUTPUT_DIR ?? '';
}
