import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { dirForGeneration } from '@/lib/outputDirs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
  let body: { generationId: string };
  try {
    body = await req.json() as { generationId: string };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  if (!body.generationId || typeof body.generationId !== 'string') {
    return new Response(JSON.stringify({ error: 'generationId is required' }), { status: 400 });
  }

  const generation = await prisma.generation.findUnique({
    where: { id: body.generationId },
    select: { filePath: true, mediaType: true, isStitched: true },
  });

  if (!generation) {
    return new Response(JSON.stringify({ error: 'Generation not found' }), { status: 404 });
  }

  if (generation.mediaType !== 'video') {
    return new Response(JSON.stringify({ error: 'Generation is not a video' }), { status: 400 });
  }

  const outputDir = dirForGeneration(generation);
  if (!outputDir) {
    return new Response(JSON.stringify({ error: 'Output directory env var not configured' }), { status: 500 });
  }

  // Derive local path from DB filePath (stored as /api/images/<filename>)
  const filename = generation.filePath.replace(/^\/api\/images\//, '');

  // Defense-in-depth: reject any path traversal even though path comes from DB
  if (filename.includes('..') || path.isAbsolute(filename)) {
    return new Response(JSON.stringify({ error: 'Invalid file path' }), { status: 400 });
  }

  const localPath = path.join(outputDir, filename);
  const resolvedPath = path.resolve(localPath);
  const resolvedOutputDir = path.resolve(outputDir);
  if (!resolvedPath.startsWith(resolvedOutputDir + path.sep)) {
    return new Response(JSON.stringify({ error: 'Invalid file path' }), { status: 400 });
  }

  try {
    // -sseof -0.1 seeks 0.1s before end (reliable for webm); -vcodec png + image2pipe outputs PNG to stdout
    const result = await execFileAsync('ffmpeg', [
      '-sseof', '-0.1',
      '-i', localPath,
      '-vframes', '1',
      '-vcodec', 'png',
      '-f', 'image2pipe',
      'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });

    const stdout = result.stdout as unknown as Buffer;
    const frameB64 = `data:image/png;base64,${stdout.toString('base64')}`;
    return new Response(JSON.stringify({ frameB64 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString?.() ?? String(err);
    console.error('[extract-last-frame] ffmpeg error:', stderr.slice(0, 1000));
    return new Response(
      JSON.stringify({ error: 'ffmpeg failed to extract frame', details: stderr.slice(0, 500) }),
      { status: 500 },
    );
  }
}
