import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { GenerationParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let params: GenerationParams;
  try {
    params = await req.json() as GenerationParams;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  function bad(message: string) {
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (typeof params.checkpoint !== 'string' || params.checkpoint.length === 0) {
    return bad('checkpoint must be a non-empty string');
  }
  if (!Array.isArray(params.loras)) {
    return bad('loras must be an array');
  }
  for (const lora of params.loras) {
    if (typeof lora?.name !== 'string' || lora.name.length === 0) {
      return bad('each lora must have a non-empty name');
    }
    if (typeof lora.weight !== 'number' || !Number.isFinite(lora.weight)) {
      return bad('each lora must have a numeric weight');
    }
  }
  if (typeof params.positivePrompt !== 'string') return bad('positivePrompt must be a string');
  if (typeof params.negativePrompt !== 'string') return bad('negativePrompt must be a string');
  if (!Number.isInteger(params.width) || params.width < 64 || params.width > 4096) {
    return bad('width must be an integer between 64 and 4096');
  }
  if (!Number.isInteger(params.height) || params.height < 64 || params.height > 4096) {
    return bad('height must be an integer between 64 and 4096');
  }
  if (!Number.isInteger(params.steps) || params.steps < 1 || params.steps > 200) {
    return bad('steps must be an integer between 1 and 200');
  }
  if (typeof params.cfg !== 'number' || !Number.isFinite(params.cfg) || params.cfg < 0 || params.cfg > 30) {
    return bad('cfg must be a number between 0 and 30');
  }
  if (typeof params.seed !== 'number' || !Number.isInteger(params.seed)) {
    return bad('seed must be an integer (use -1 for random)');
  }
  if (typeof params.sampler !== 'string' || params.sampler.length === 0) {
    return bad('sampler must be a non-empty string');
  }
  if (typeof params.scheduler !== 'string' || params.scheduler.length === 0) {
    return bad('scheduler must be a non-empty string');
  }
  if (!Number.isInteger(params.batchSize) || params.batchSize < 1 || params.batchSize > 8) {
    return bad('batchSize must be an integer between 1 and 8');
  }

  if (params.mask) {
    if (typeof params.mask !== 'string' || params.mask.length === 0) {
      return bad('mask must be a non-empty base64 string');
    }
    if (!params.baseImage) {
      return bad('mask requires baseImage to also be set');
    }
    const decodedSize = Math.floor(params.mask.length * 0.75);
    if (decodedSize > 8 * 1024 * 1024) {
      return bad('mask too large (over 8MB decoded)');
    }
  }

  if (params.referenceImages) {
    const refs = params.referenceImages;
    if (!Array.isArray(refs.images) || refs.images.length === 0 || refs.images.length > 3) {
      return bad('referenceImages.images must be 1-3 entries');
    }
    for (const b64 of refs.images) {
      if (typeof b64 !== 'string' || b64.length === 0) {
        return bad('each reference image must be a non-empty base64 string');
      }
      if (b64.startsWith('data:')) {
        return bad('reference images must be base64 only, no data: prefix');
      }
      const decodedSize = Math.floor(b64.length * 0.75);
      if (decodedSize < 100 * 1024) {
        return bad('reference image too small (under 100KB decoded)');
      }
      if (decodedSize > 8 * 1024 * 1024) {
        return bad('reference image too large (over 8MB decoded)');
      }
    }
    if (typeof refs.strength !== 'number' || refs.strength < 0 || refs.strength > 1.5) {
      return bad('referenceImages.strength must be 0.0-1.5');
    }
  }

  if (params.projectId !== undefined && params.projectId !== null) {
    if (typeof params.projectId !== 'string' || params.projectId.length === 0) {
      return bad('projectId must be a non-empty string when provided');
    }
    const project = await prisma.project.findUnique({ where: { id: params.projectId } });
    if (!project) {
      return bad('projectId does not reference an existing project');
    }
  }

  if (params.sceneId !== undefined && params.sceneId !== null) {
    if (typeof params.sceneId !== 'string' || params.sceneId.length === 0) {
      return bad('sceneId must be a non-empty string when provided');
    }
  }

  // Enqueue the job; the runner will pick it up within RUNNER_TICK_MS (5 s)
  const job = await prisma.queuedJob.create({
    data: {
      mediaType: 'image',
      payloadJson: params as unknown as Parameters<typeof prisma.queuedJob.create>[0]['data']['payloadJson'],
      projectId: params.projectId ?? null,
      sceneId: params.sceneId ?? null,
      status: 'pending',
    },
  });

  return NextResponse.json({ queuedJobId: job.id, status: 'pending' }, { status: 202 });
}
