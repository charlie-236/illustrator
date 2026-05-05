import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { unlink } from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { getComfyWSManager } from '@/lib/comfyws';
import { stitchProject } from '@/lib/stitch';
import { dirForGeneration } from '@/lib/outputDirs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 30)
    .replace(/_+$/, '') || 'stitched';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const outputDir = process.env.STITCH_OUTPUT_DIR;
  if (!outputDir) {
    return new Response(
      JSON.stringify({ error: 'STITCH_OUTPUT_DIR not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { id: projectId } = await params;

  let body: { transition?: string; clipIds?: string[]; storyboardId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const transition: 'hard-cut' | 'crossfade' =
    body.transition === 'crossfade' ? 'crossfade' : 'hard-cut';

  // ─── load project + all video clips ──────────────────────────────────────

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) {
    return new Response(JSON.stringify({ error: 'Project not found' }), { status: 404 });
  }

  // Validate storyboardId if provided, and resolve storyboard name for filename
  let storyboardName: string | null = null;
  if (body.storyboardId) {
    const sb = await prisma.storyboard.findFirst({
      where: { id: body.storyboardId, projectId },
      select: { name: true },
    });
    if (!sb) {
      return new Response(
        JSON.stringify({ error: 'Storyboard not found or does not belong to this project' }),
        { status: 400 },
      );
    }
    storyboardName = sb.name;
  }

  const allVideoClips = await prisma.generation.findMany({
    where: { projectId, mediaType: 'video' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, filePath: true, mediaType: true, isStitched: true },
  });

  const totalVideoCount = allVideoClips.length;

  // ─── resolve clip selection ────────────────────────────────────────────────

  let clips: { id: string; filePath: string; mediaType: string; isStitched: boolean }[];

  if (body.clipIds !== undefined) {
    if (body.clipIds.length < 2) {
      return new Response(
        JSON.stringify({ error: 'Need at least 2 video clips to stitch' }),
        { status: 400 },
      );
    }

    const videoClipMap = new Map(allVideoClips.map((c) => [c.id, c]));

    for (const clipId of body.clipIds) {
      if (!videoClipMap.has(clipId)) {
        // Distinguish between non-video clip and foreign clip
        const anyClip = await prisma.generation.findFirst({
          where: { id: clipId, projectId },
          select: { mediaType: true },
        });
        if (anyClip) {
          return new Response(
            JSON.stringify({ error: `Clip ${clipId} is not a video clip — only video clips can be stitched` }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ error: `Clip ${clipId} does not belong to this project` }),
          { status: 400 },
        );
      }
    }

    clips = body.clipIds.map((id) => videoClipMap.get(id)!);
  } else {
    // Default: all video clips in position order
    if (allVideoClips.length < 2) {
      return new Response(
        JSON.stringify({ error: 'Need at least 2 video clips to stitch' }),
        { status: 400 },
      );
    }
    clips = allVideoClips;
  }

  // ─── build local paths ────────────────────────────────────────────────────

  const clipPaths = clips.map((c) => {
    const filename = c.filePath.replace('/api/images/', '').replace('/generations/', '');
    const clipDir = dirForGeneration(c);
    if (!clipDir) {
      throw new Error(`Source clip directory env var not configured for clip ${c.id}`);
    }
    return path.join(clipDir, filename);
  });

  // ─── generate IDs and output path ─────────────────────────────────────────

  const generationId = uuidv4();
  const promptId = uuidv4();
  const label = storyboardName ? `${project.name} — ${storyboardName}` : `stitched ${project.name}`;
  const slug = slugify(label);
  const filename = `${slug}_${Date.now()}.mp4`;
  const outputPath = path.join(outputDir, filename);
  const filePath = `/api/images/${filename}`;
  const promptSummary = (storyboardName
    ? `Stitched: ${storyboardName}`
    : `Stitched: ${project.name}`
  ).slice(0, 60);

  // ─── create pending Generation row ───────────────────────────────────────

  await prisma.generation.create({
    data: {
      id: generationId,
      filePath,
      promptPos: storyboardName ? `Stitched: ${storyboardName}` : `Stitched: ${project.name}`,
      promptNeg: '',
      model: 'stitch',
      seed: BigInt(0),
      cfg: 0,
      steps: 0,
      width: 0,
      height: 0,
      sampler: 'none',
      scheduler: 'none',
      highResFix: false,
      mediaType: 'video',
      isStitched: true,
      parentProjectId: projectId,
      storyboardId: body.storyboardId ?? null,
      // Store selection + total so gallery can show "X of N from project Y"
      stitchedClipIds: JSON.stringify({ selected: clips.map((c) => c.id), total: totalVideoCount }),
    },
  });

  // ─── SSE stream ───────────────────────────────────────────────────────────

  const manager = getComfyWSManager();
  const sseEncoder = new TextEncoder();
  let capturedController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      capturedController = controller;

      controller.enqueue(
        sseEncoder.encode(`event: init\ndata: ${JSON.stringify({ promptId, generationId })}\n\n`),
      );

      manager.registerStitchJob(promptId, generationId, outputPath, controller, promptSummary, undefined, projectId);

      // Client disconnect — detach controller; ffmpeg keeps running (refresh survivability)
      req.signal.addEventListener('abort', () => {
        manager.removeSubscriber(promptId, controller);
        try { controller.close(); } catch { /* already closed */ }
      });

      // Run stitch asynchronously; all events pushed through manager
      void (async () => {
        try {
          const result = await stitchProject({
            clipPaths,
            outputPath,
            transition,
            onProgress: (frame, total) =>
              manager.updateStitchProgress(promptId, { current: frame, total }),
            onChildProcess: (cp) => manager.setStitchProcess(promptId, cp),
          });

          const updatedRecord = await prisma.generation.update({
            where: { id: generationId },
            data: {
              width: result.width,
              height: result.height,
              frames: result.frameCount,
              fps: 16,
            },
          });

          manager.finalizeStitchSuccess(promptId, generationId, {
            ...updatedRecord,
            seed: updatedRecord.seed.toString(),
            createdAt: updatedRecord.createdAt.toISOString(),
          });
        } catch (err) {
          // Delete partial output file (abort path may have already done this — idempotent)
          await unlink(outputPath).catch(() => {});
          // Remove the orphan DB row (stitch never completed)
          await prisma.generation.delete({ where: { id: generationId } }).catch(() => {});
          // no-op if job was already handled by abortJob()
          manager.finalizeStitchError(promptId, String(err));
        }
      })();
    },
    cancel() {
      if (capturedController) manager.removeSubscriber(promptId, capturedController);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
