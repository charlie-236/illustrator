import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { WanLoraSpec } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VideoRequest {
  mode: 't2v' | 'i2v';
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed?: number;
  startImageB64?: string;
  projectId?: string;
  lightning?: boolean;
  loras?: WanLoraSpec[];
  batchSize?: number;
  sceneId?: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.VIDEO_OUTPUT_DIR) {
    return NextResponse.json({ error: 'VIDEO_OUTPUT_DIR is not configured' }, { status: 500 });
  }

  let body: VideoRequest;
  try {
    body = await req.json() as VideoRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { mode, prompt, width, height, frames, steps, cfg, startImageB64 } = body;
  const lightning = body.lightning === true;

  if (mode !== 't2v' && mode !== 'i2v') {
    return NextResponse.json({ error: "mode must be 't2v' or 'i2v'" }, { status: 400 });
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 });
  }
  if (!Number.isInteger(width) || width < 256 || width > 1280 || width % 32 !== 0) {
    return NextResponse.json({ error: 'width must be an integer multiple of 32, 256–1280 inclusive' }, { status: 400 });
  }
  if (!Number.isInteger(height) || height < 256 || height > 1280 || height % 32 !== 0) {
    return NextResponse.json({ error: 'height must be an integer multiple of 32, 256–1280 inclusive' }, { status: 400 });
  }
  if (!Number.isInteger(frames) || frames < 17 || frames > 121 || (frames - 1) % 8 !== 0) {
    return NextResponse.json({ error: 'frames must be an integer satisfying (frames-1) % 8 === 0, range 17–121' }, { status: 400 });
  }
  if (!lightning) {
    if (!Number.isInteger(steps) || steps < 4 || steps > 40 || steps % 2 !== 0) {
      return NextResponse.json({ error: 'steps must be an even integer, 4–40 inclusive' }, { status: 400 });
    }
    if (typeof cfg !== 'number' || !Number.isFinite(cfg) || cfg < 1.0 || cfg > 10.0) {
      return NextResponse.json({ error: 'cfg must be a number 1.0–10.0 inclusive' }, { status: 400 });
    }
  }
  if (mode === 'i2v' && !startImageB64) {
    return NextResponse.json({ error: "startImageB64 is required for mode='i2v'" }, { status: 400 });
  }
  if (mode === 't2v' && startImageB64) {
    return NextResponse.json({ error: "startImageB64 is not allowed for mode='t2v'" }, { status: 400 });
  }

  if (body.projectId !== undefined) {
    if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
      return NextResponse.json({ error: 'projectId must be a non-empty string' }, { status: 400 });
    }
    const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { id: true } });
    if (!project) {
      return NextResponse.json({ error: 'projectId does not reference an existing project' }, { status: 400 });
    }
  }

  const batchSize = body.batchSize ?? 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4) {
    return NextResponse.json({ error: 'batchSize must be an integer between 1 and 4 inclusive' }, { status: 400 });
  }

  if (body.sceneId !== undefined && (typeof body.sceneId !== 'string' || body.sceneId.trim().length === 0)) {
    return NextResponse.json({ error: 'sceneId must be a non-empty string' }, { status: 400 });
  }

  // Enqueue; runner resolves seed, builds workflow, submits to ComfyUI
  const job = await prisma.queuedJob.create({
    data: {
      mediaType: 'video',
      payloadJson: body as unknown as Parameters<typeof prisma.queuedJob.create>[0]['data']['payloadJson'],
      projectId: body.projectId ?? null,
      sceneId: body.sceneId ?? null,
      status: 'pending',
    },
  });

  return NextResponse.json({ queuedJobId: job.id, status: 'pending' }, { status: 202 });
}
