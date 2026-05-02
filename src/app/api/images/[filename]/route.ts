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

  const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
  if (!IMAGE_OUTPUT_DIR) {
    return new NextResponse('IMAGE_OUTPUT_DIR not configured', { status: 500 });
  }
  const filePath = path.join(IMAGE_OUTPUT_DIR, filename);

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === '.png' ? 'image/png' :
      ext === '.webm' ? 'video/webm' :
      'image/jpeg';

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse('Not Found', { status: 404 });
  }
}
