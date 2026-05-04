import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Reject any path traversal attempts
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const ext = path.extname(filename).toLowerCase();
  const contentType =
    ext === '.png'  ? 'image/png'  :
    ext === '.webm' ? 'video/webm' :
    ext === '.mp4'  ? 'video/mp4'  :
    'image/jpeg';

  // Try each output directory in order: images → clips → videos.
  // Filenames are unique (slug + timestamp), so the first hit is the right one.
  // This lets VIDEO_OUTPUT_DIR and STITCH_OUTPUT_DIR point somewhere other than
  // IMAGE_OUTPUT_DIR without breaking URLs for files created before the split.
  const dirs = [
    process.env.IMAGE_OUTPUT_DIR,
    process.env.VIDEO_OUTPUT_DIR,
    process.env.STITCH_OUTPUT_DIR,
  ].filter((d): d is string => Boolean(d));

  if (dirs.length === 0) {
    return new NextResponse('Output directories not configured', { status: 500 });
  }

  for (const dir of dirs) {
    const filePath = path.join(dir, filename);
    try {
      const data = await readFile(filePath);
      return new NextResponse(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      // ENOENT — try next directory
    }
  }

  return new NextResponse('Not Found', { status: 404 });
}
