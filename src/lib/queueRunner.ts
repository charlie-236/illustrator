/**
 * Phase 8: Durable app-side queue runner.
 *
 * Ticks every 5 s:
 * 1. Check WS connectivity — abort if ComfyUI is unreachable.
 * 2. Reconcile ghost jobs (in-DB as submitted/running but gone from manager).
 * 3. If ComfyUI is idle, submit the oldest pending QueuedJob.
 * 4. Clean up terminal QueuedJob rows older than RECENT_COMPLETED_TTL_MS.
 */

import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { unlink } from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { getComfyWSManager, type VideoJobParams } from './comfyws';
import { buildWorkflow } from './workflow';
import { buildT2VWorkflow, buildI2VWorkflow, WAN22_DEFAULT_NEGATIVE_PROMPT } from './wan22-workflow';
import { stitchProject } from './stitch';
import { dirForGeneration } from './outputDirs';
import type { GenerationParams, WanLoraSpec } from '@/types';

const COMFYUI_URL = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
const VIDEO_OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR ?? '';
const STITCH_OUTPUT_DIR = process.env.STITCH_OUTPUT_DIR ?? '';
const RUNNER_TICK_MS = 5_000;
const MAX_RETRIES_FOR_VM_LOSS = 1;
const RECENT_COMPLETED_TTL_MS = Number(process.env.RECENT_COMPLETED_TTL_MS) || 5 * 60 * 1000;

let runnerInterval: ReturnType<typeof setInterval> | null = null;
let runnerBusy = false;

/**
 * Starts the queue runner. Idempotent — safe to call multiple times
 * (e.g., across hot-reloads). The global.__comfyWSManager singleton
 * ensures only one WS connection exists regardless of how often this is called.
 */
export function startQueueRunner(): void {
  if (runnerInterval) return;

  // Run once immediately at startup to recover from any pending jobs
  void runnerTick();

  runnerInterval = setInterval(() => {
    if (runnerBusy) return;
    runnerBusy = true;
    void runnerTick().finally(() => { runnerBusy = false; });
  }, RUNNER_TICK_MS);
}

async function runnerTick(): Promise<void> {
  const manager = getComfyWSManager();

  // Step 1: Only operate when WS is connected — if VM is down, don't submit
  if (!manager.isConnected()) return;

  // Step 2: Reconcile ghost jobs (submitted/running in DB but absent from manager)
  await reconcileGhostJobs(manager);

  // Step 3: Submit next pending job only if ComfyUI is idle
  const activeJobs = manager.getActiveJobs();
  const anyActive = activeJobs.some(
    (j) => j.status === 'running' || j.status === 'queued',
  );
  if (!anyActive) {
    const next = await prisma.queuedJob.findFirst({
      where: { status: 'pending' },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    if (next) {
      await submitJob(next);
    }
  }

  // Step 4: Cleanup terminal rows older than TTL
  const cutoff = new Date(Date.now() - RECENT_COMPLETED_TTL_MS);
  await prisma.queuedJob.deleteMany({
    where: {
      status: { in: ['complete', 'failed', 'cancelled'] },
      finishedAt: { lt: cutoff },
    },
  }).catch(() => { /* non-critical */ });
}

/**
 * Checks DB for jobs marked submitted/running whose promptId is no longer
 * known to the manager. These are ghosts — the VM likely restarted.
 * Auto-retry once (vm_lost), then mark terminal.
 */
async function reconcileGhostJobs(manager: ReturnType<typeof getComfyWSManager>): Promise<void> {
  const inFlight = await prisma.queuedJob.findMany({
    where: { status: { in: ['submitted', 'running'] } },
  });
  if (inFlight.length === 0) return;

  const liveJobs = manager.getActiveJobs();
  const livePromptIds = new Set(liveJobs.map((j) => j.promptId));

  for (const job of inFlight) {
    // If promptId is in manager's active set, still alive — skip
    if (job.promptId && livePromptIds.has(job.promptId)) continue;

    if (job.retryCount < MAX_RETRIES_FOR_VM_LOSS) {
      // Auto-retry: reset to pending
      await prisma.queuedJob.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          promptId: null,
          submittedAt: null,
          startedAt: null,
          retryCount: { increment: 1 },
          lastFailReason: 'vm_lost',
        },
      });
      console.log(`[queue] auto-retry on VM loss: ${job.id} (attempt ${job.retryCount + 1})`);
    } else {
      // Exhausted retries — terminal failure
      await prisma.queuedJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastFailReason: 'vm_lost',
          finishedAt: new Date(),
        },
      });
      console.log(`[queue] terminal failure (vm_lost, retries exhausted): ${job.id}`);
    }
  }
}

// ─── Submission dispatcher ─────────────────────────────────────────────────────

type QueuedJobRow = Awaited<ReturnType<typeof prisma.queuedJob.findFirst>> & object;

async function submitJob(job: NonNullable<Awaited<ReturnType<typeof prisma.queuedJob.findFirst>>>): Promise<void> {
  // Mark as submitted before doing I/O — prevents double-submission on concurrent ticks
  await prisma.queuedJob.update({
    where: { id: job.id },
    data: { status: 'submitted', submittedAt: new Date() },
  });

  try {
    let promptId: string;
    switch (job.mediaType) {
      case 'image':
        promptId = await submitImageJob(job);
        break;
      case 'video':
        promptId = await submitVideoJob(job);
        break;
      case 'stitch':
        promptId = await submitStitchJob(job);
        break;
      default:
        throw new Error(`Unknown mediaType: ${job.mediaType}`);
    }

    // Store promptId; status transitions to 'running' when manager's execution_start fires
    // (and finally to 'complete'/'failed' from comfyws finalization paths).
    await prisma.queuedJob.update({
      where: { id: job.id },
      data: { promptId, status: 'running' },
    });
  } catch (err) {
    console.error(`[queue] submit failed for ${job.id}:`, err);
    await prisma.queuedJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        lastFailReason: 'workflow_error',
        finishedAt: new Date(),
      },
    });
  }
}

// ─── Image job submission ──────────────────────────────────────────────────────

async function submitImageJob(
  job: NonNullable<Awaited<ReturnType<typeof prisma.queuedJob.findFirst>>>,
): Promise<string> {
  const params = job.payloadJson as unknown as GenerationParams;
  const manager = getComfyWSManager();

  // Assemble prompts (mirrors /api/generate route logic)
  const positiveParts: string[] = [];
  const negativeParts: string[] = [];

  if (params.checkpoint) {
    try {
      const ckptConfig = await prisma.checkpointConfig.findUnique({
        where: { checkpointName: params.checkpoint },
      });
      if (ckptConfig?.defaultPositivePrompt) positiveParts.push(ckptConfig.defaultPositivePrompt);
      if (ckptConfig?.defaultNegativePrompt) negativeParts.push(ckptConfig.defaultNegativePrompt);
    } catch { /* non-critical */ }
  }

  if (params.loras && params.loras.length > 0) {
    try {
      const loraConfigs = await prisma.loraConfig.findMany({
        where: { loraName: { in: params.loras.map((l) => l.name) } },
      });
      const loraConfigMap = new Map(loraConfigs.map((c) => [c.loraName, c]));
      for (const lora of params.loras) {
        const cfg = loraConfigMap.get(lora.name);
        if (cfg?.triggerWords) positiveParts.push(cfg.triggerWords);
      }
    } catch { /* non-critical */ }
  }

  if (params.positivePrompt) positiveParts.push(params.positivePrompt);
  if (params.negativePrompt) negativeParts.push(params.negativePrompt);

  const finalPositive = positiveParts.join(', ');
  const finalNegative = negativeParts.join(', ');

  const workflowParams: GenerationParams = {
    ...params,
    positivePrompt: finalPositive,
    negativePrompt: finalNegative,
  };

  const { workflow, resolvedSeed } = buildWorkflow(workflowParams);

  // Disk-avoidance guard
  for (const [nodeId, node] of Object.entries(workflow)) {
    const ct = (node as { class_type: string }).class_type;
    if (ct === 'SaveImage' || ct === 'LoadImage') {
      throw new Error(`Forbidden class_type "${ct}" in node ${nodeId}`);
    }
  }

  const comfyRes = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: manager.getClientId() }),
  });

  if (!comfyRes.ok) {
    const body = await comfyRes.text();
    throw new Error(`ComfyUI /prompt failed: ${comfyRes.status} ${body}`);
  }

  const { prompt_id: promptId } = await comfyRes.json() as { prompt_id: string };
  if (!promptId) throw new Error('No prompt_id in ComfyUI response');

  // Strip large fields not needed for finalization
  const { referenceImages: _ri, mask: _mk, baseImage: _bi, denoise: _d, ...paramsForJob } = params;

  // Register with manager — no SSE subscriber (null controller; job tracked via DB + polling)
  manager.registerJob(
    promptId,
    paramsForJob as GenerationParams,
    resolvedSeed,
    finalPositive,
    finalNegative,
    null,
  );

  return promptId;
}

// ─── Video job submission ──────────────────────────────────────────────────────

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
  sceneId?: string;
}

async function submitVideoJob(
  job: NonNullable<Awaited<ReturnType<typeof prisma.queuedJob.findFirst>>>,
): Promise<string> {
  if (!VIDEO_OUTPUT_DIR) throw new Error('VIDEO_OUTPUT_DIR is not configured');

  const body = job.payloadJson as unknown as VideoRequest;
  const manager = getComfyWSManager();

  const { mode, prompt, width, height, frames } = body;
  const lightning = body.lightning === true;
  const loras: WanLoraSpec[] = Array.isArray(body.loras) ? body.loras : [];

  const explicitSeed =
    typeof body.seed === 'number' && Number.isInteger(body.seed) && body.seed !== -1
      ? body.seed
      : null;
  const seed = explicitSeed ?? Math.floor(Math.random() * 2 ** 32);

  const effectiveSteps = lightning ? 4 : (body.steps ?? 20);
  const effectiveCfg = lightning ? 1 : (body.cfg ?? 3.5);

  const generationId = uuidv4();
  const filenamePrefix = randomBytes(8).toString('hex');

  const videoParams: VideoJobParams = {
    generationId,
    filenamePrefix,
    prompt: prompt.trim(),
    negativePrompt:
      body.negativePrompt && body.negativePrompt.trim().length > 0
        ? body.negativePrompt
        : WAN22_DEFAULT_NEGATIVE_PROMPT,
    width,
    height,
    frames,
    steps: effectiveSteps,
    cfg: effectiveCfg,
    seed,
    mode,
    outputDir: VIDEO_OUTPUT_DIR,
    lightning,
    loras,
    ...(body.projectId ? { projectId: body.projectId } : {}),
    ...(body.sceneId ? { sceneId: body.sceneId } : {}),
  };

  // Record the generationId on QueuedJob so polling can return it after completion
  await prisma.queuedJob.update({
    where: { id: job.id },
    data: { generationId },
  });

  let workflow;
  if (mode === 'i2v') {
    if (!body.startImageB64) throw new Error("startImageB64 required for i2v");
    workflow = buildI2VWorkflow({ ...videoParams, startImageB64: body.startImageB64 });
  } else {
    workflow = buildT2VWorkflow(videoParams);
  }

  // Video workflow guard
  for (const [nodeId, node] of Object.entries(workflow)) {
    const cls = (node as { class_type: string }).class_type;
    if (cls === 'SaveImage') throw new Error(`SaveImage forbidden (node ${nodeId})`);
    if (cls === 'LoadImage') throw new Error(`LoadImage forbidden (node ${nodeId})`);
    if (cls === 'SaveAnimatedWEBP') throw new Error(`SaveAnimatedWEBP forbidden (node ${nodeId})`);
  }

  const comfyRes = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: manager.getClientId() }),
  });

  if (!comfyRes.ok) {
    const respBody = await comfyRes.text();
    throw new Error(`ComfyUI /prompt failed: ${comfyRes.status} ${respBody}`);
  }

  const { prompt_id: promptId } = await comfyRes.json() as { prompt_id: string };
  if (!promptId) throw new Error('No prompt_id in ComfyUI response');

  // Register with manager — null controller (no SSE subscriber)
  manager.registerVideoJob(promptId, videoParams, null);

  return promptId;
}

// ─── Stitch job submission ─────────────────────────────────────────────────────

interface StitchPayload {
  projectId: string;
  transition: 'hard-cut' | 'crossfade';
  clipIds?: string[];
  storyboardId?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 30)
    .replace(/_+$/, '') || 'stitched';
}

async function submitStitchJob(
  job: NonNullable<Awaited<ReturnType<typeof prisma.queuedJob.findFirst>>>,
): Promise<string> {
  if (!STITCH_OUTPUT_DIR) throw new Error('STITCH_OUTPUT_DIR is not configured');

  const payload = job.payloadJson as unknown as StitchPayload;
  const { projectId, transition, storyboardId } = payload;
  const manager = getComfyWSManager();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  let storyboardName: string | null = null;
  if (storyboardId) {
    const sb = await prisma.storyboard.findFirst({
      where: { id: storyboardId, projectId },
      select: { name: true },
    });
    storyboardName = sb?.name ?? null;
  }

  const allVideoClips = await prisma.generation.findMany({
    where: { projectId, mediaType: 'video' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, filePath: true, mediaType: true, isStitched: true },
  });

  const totalVideoCount = allVideoClips.length;

  let clips: typeof allVideoClips;
  if (payload.clipIds) {
    const videoClipMap = new Map(allVideoClips.map((c) => [c.id, c]));
    clips = payload.clipIds.map((id) => {
      const c = videoClipMap.get(id);
      if (!c) throw new Error(`Clip ${id} not found in project ${projectId}`);
      return c;
    });
  } else {
    clips = allVideoClips;
  }

  if (clips.length < 2) throw new Error('Need at least 2 video clips to stitch');

  const clipPaths = clips.map((c) => {
    const filename = c.filePath.replace('/api/images/', '').replace('/generations/', '');
    const clipDir = dirForGeneration(c);
    if (!clipDir) throw new Error(`Output dir not configured for clip ${c.id}`);
    return path.join(clipDir, filename);
  });

  const generationId = uuidv4();
  const promptId = uuidv4();
  const label = storyboardName ? `${project.name} — ${storyboardName}` : `stitched ${project.name}`;
  const slug = slugify(label);
  const filename = `${slug}_${Date.now()}.mp4`;
  const outputPath = path.join(STITCH_OUTPUT_DIR, filename);
  const filePath = `/api/images/${filename}`;
  const promptSummary = (storyboardName
    ? `Stitched: ${storyboardName}`
    : `Stitched: ${project.name}`
  ).slice(0, 60);

  // Create pending Generation row
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
      storyboardId: storyboardId ?? null,
      stitchedClipIds: JSON.stringify({ selected: clips.map((c) => c.id), total: totalVideoCount }),
    },
  });

  // Update QueuedJob with generationId before starting async work
  await prisma.queuedJob.update({
    where: { id: job.id },
    data: { generationId },
  });

  manager.registerStitchJob(promptId, generationId, outputPath, null, promptSummary, undefined, projectId);

  // Fire-and-forget ffmpeg
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
      await unlink(outputPath).catch(() => {});
      await prisma.generation.delete({ where: { id: generationId } }).catch(() => {});
      manager.finalizeStitchError(promptId, String(err));
    }
  })();

  return promptId;
}
