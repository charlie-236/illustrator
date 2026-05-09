import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!process.env.STITCH_OUTPUT_DIR) {
    return NextResponse.json({ error: 'STITCH_OUTPUT_DIR not configured' }, { status: 500 });
  }

  const { id: projectId } = await params;

  let body: { transition?: string; clipIds?: string[]; storyboardId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const transition: 'hard-cut' | 'crossfade' =
    body.transition === 'crossfade' ? 'crossfade' : 'hard-cut';

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  if (body.storyboardId) {
    const sb = await prisma.storyboard.findFirst({
      where: { id: body.storyboardId, projectId },
      select: { id: true },
    });
    if (!sb) {
      return NextResponse.json(
        { error: 'Storyboard not found or does not belong to this project' },
        { status: 400 },
      );
    }
  }

  // Validate clipIds — must be video clips in this project
  if (body.clipIds !== undefined) {
    if (body.clipIds.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 video clips to stitch' }, { status: 400 });
    }
    const allVideoClips = await prisma.generation.findMany({
      where: { projectId, mediaType: 'video' },
      select: { id: true },
    });
    const videoClipIds = new Set(allVideoClips.map((c) => c.id));
    for (const clipId of body.clipIds) {
      if (!videoClipIds.has(clipId)) {
        const anyClip = await prisma.generation.findFirst({
          where: { id: clipId, projectId },
          select: { mediaType: true },
        });
        if (anyClip) {
          return NextResponse.json(
            { error: `Clip ${clipId} is not a video clip — only video clips can be stitched` },
            { status: 400 },
          );
        }
        return NextResponse.json(
          { error: `Clip ${clipId} does not belong to this project` },
          { status: 400 },
        );
      }
    }
  } else {
    const videoCount = await prisma.generation.count({
      where: { projectId, mediaType: 'video' },
    });
    if (videoCount < 2) {
      return NextResponse.json({ error: 'Need at least 2 video clips to stitch' }, { status: 400 });
    }
  }

  const payload = {
    projectId,
    transition,
    ...(body.clipIds ? { clipIds: body.clipIds } : {}),
    ...(body.storyboardId ? { storyboardId: body.storyboardId } : {}),
  };

  const job = await prisma.queuedJob.create({
    data: {
      mediaType: 'stitch',
      payloadJson: payload,
      projectId,
      storyboardId: body.storyboardId ?? null,
      status: 'pending',
    },
  });

  return NextResponse.json({ queuedJobId: job.id, status: 'pending' }, { status: 202 });
}
