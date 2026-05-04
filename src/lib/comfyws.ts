import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import type { Prisma } from '@prisma/client';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { GenerationParams } from '@/types';
import { NodeSSH } from 'node-ssh';
import { prisma } from './prisma';

// ─── job types ───────────────────────────────────────────────────────────────

export interface VideoJobParams {
  generationId: string;
  filenamePrefix: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;
  mode: 't2v' | 'i2v';
  outputDir: string;
  /** When true, generation used Lightning distillation (4-step, CFG=1, LCM sampler). */
  lightning?: boolean;
  /** Optional project to associate this clip with. Position is auto-computed at save time. */
  projectId?: string;
}

interface BaseJob {
  promptId: string;
  /** Null when the SSE subscriber has disconnected (refresh/tab-close). The job
   *  continues running; finalization still writes to DB and recentlyCompleted. */
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Image frames accumulate here for image jobs; always empty for video jobs. */
  imageBuffers: Buffer[];
  activeNode: string | null;
  finalized: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** First ~60 chars of the positive prompt, for the queue tray display. */
  promptSummary: string;
  /** Unix ms timestamp when the job was registered (submitted to ComfyUI). */
  startedAt: number;
  /** Unix ms timestamp when ComfyUI began executing this job (first `executing` WS message).
   *  Null while the job sits in ComfyUI's queue waiting for the GPU. */
  runningSince: number | null;
  /** Latest sampling progress, updated as WS events arrive. */
  progress: { current: number; total: number } | null;
}

interface ImageJob extends BaseJob {
  mediaType: 'image';
  params: GenerationParams;
  resolvedSeed: number;
  assembledPos: string;
  assembledNeg: string;
}

interface VideoJob extends BaseJob {
  mediaType: 'video';
  videoParams: VideoJobParams;
  /** Set by the `executed` message handler when SaveWEBM reports its output. */
  videoResult?: { filename: string; subfolder: string };
}

interface StitchJob extends BaseJob {
  mediaType: 'stitch';
  generationId: string;
  outputPath: string;
  childProcess: ChildProcessWithoutNullStreams | null;
  /** Source project for this stitch — used to abort jobs when cascade-deleting a project. */
  projectId?: string;
}

type Job = ImageJob | VideoJob | StitchJob;

// ─── recently-completed cache ─────────────────────────────────────────────────

interface RecentlyCompletedEntry {
  promptId: string;
  generationId: string;
  mediaType: 'image' | 'video' | 'stitch';
  promptSummary: string;
  status: 'done' | 'error';
  errorMessage?: string;
  completedAt: number;
}

// ─── public shape returned by getActiveJobs() ─────────────────────────────────

export interface ActiveJobInfo {
  promptId: string;
  generationId: string;
  mediaType: 'image' | 'video' | 'stitch';
  promptSummary: string;
  startedAt: number;
  /** Unix ms when ComfyUI started executing the job; null while queued. */
  runningSince: number | null;
  progress: { current: number; total: number } | null;
  status: 'queued' | 'running' | 'done' | 'error';
  errorMessage?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const COMFYUI_WS = process.env.COMFYUI_WS_URL ?? 'ws://127.0.0.1:8188';
const COMFYUI_HTTP = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
const IMAGE_JOB_TIMEOUT_MS = Number(process.env.IMAGE_JOB_TIMEOUT_MS) || 10 * 60 * 1000;
const VIDEO_JOB_TIMEOUT_MS = Number(process.env.VIDEO_JOB_TIMEOUT_MS) || 15 * 60 * 1000;
const STITCH_JOB_TIMEOUT_MS = Number(process.env.STITCH_JOB_TIMEOUT_MS) || 5 * 60 * 1000;
const RECENT_COMPLETED_TTL_MS = Number(process.env.RECENT_COMPLETED_TTL_MS) || 5 * 60 * 1000;
const COMFYUI_OUTPUT_PATH = process.env.COMFYUI_OUTPUT_PATH ?? '/models/ComfyUI/output';
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

const encoder = new TextEncoder();

// ─── helpers ─────────────────────────────────────────────────────────────────

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pushSSE(
  controller: ReadableStreamDefaultController<Uint8Array> | null,
  event: string,
  data: unknown,
): void {
  if (!controller) return;
  try { controller.enqueue(sseChunk(event, data)); } catch { /* already closed */ }
}

function closeSSE(controller: ReadableStreamDefaultController<Uint8Array> | null): void {
  if (!controller) return;
  try { controller.close(); } catch { /* already closed */ }
}

// ComfyUI binary frame layout (server.py `send_image` / `encode_bytes`):
//   bytes 0-3  BE uint32  event type  (always 1 on the wire)
//   bytes 4-7  BE uint32  format type (1 = JPEG preview, 2 = PNG final)
//   bytes 8+              raw image data
function parseImageFrame(buf: Buffer): { format: 'png' | 'jpeg'; image: Buffer } | null {
  if (buf.length < 8) return null;

  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
  const JPEG_MAGIC = [0xff, 0xd8, 0xff];

  function scanForPng(b: Buffer): Buffer | null {
    const limit = Math.min(b.length - 4, 32);
    for (let i = 0; i <= limit; i++) {
      if (b[i] === PNG_MAGIC[0] && b[i + 1] === PNG_MAGIC[1] && b[i + 2] === PNG_MAGIC[2] && b[i + 3] === PNG_MAGIC[3]) {
        return b.subarray(i);
      }
    }
    return null;
  }

  function scanForJpeg(b: Buffer): Buffer | null {
    const limit = Math.min(b.length - 3, 32);
    for (let i = 0; i <= limit; i++) {
      if (b[i] === JPEG_MAGIC[0] && b[i + 1] === JPEG_MAGIC[1] && b[i + 2] === JPEG_MAGIC[2]) {
        return b.subarray(i);
      }
    }
    return null;
  }

  const formatType = buf.readUInt32BE(4);

  if (formatType === 2) {
    // SaveImageWebsocket always emits PNG
    const slice = buf.subarray(8);
    if (slice[0] === PNG_MAGIC[0] && slice[1] === PNG_MAGIC[1] && slice[2] === PNG_MAGIC[2] && slice[3] === PNG_MAGIC[3]) {
      return { format: 'png', image: slice };
    }
    console.warn('[ComfyWS] formatType=2 but no PNG magic at offset 8; scanning...');
    const found = scanForPng(buf);
    return found ? { format: 'png', image: found } : null;
  }

  if (formatType === 1) {
    // Live preview frames from taesd/latent2rgb/auto are JPEG
    const slice = buf.subarray(8);
    if (slice[0] === JPEG_MAGIC[0] && slice[1] === JPEG_MAGIC[1] && slice[2] === JPEG_MAGIC[2]) {
      return { format: 'jpeg', image: slice };
    }
    console.warn('[ComfyWS] formatType=1 but no JPEG magic at offset 8; scanning...');
    const found = scanForJpeg(buf);
    return found ? { format: 'jpeg', image: found } : null;
  }

  console.warn(`[ComfyWS] Unknown binary frame formatType: ${formatType}`);
  return null;
}

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 30)
    .replace(/_+$/, '');
  return slug || 'generation';
}

// ─── manager ─────────────────────────────────────────────────────────────────

class ComfyWSManager {
  private ws: WebSocket | null = null;
  private clientId: string;
  private jobs = new Map<string, Job>();
  private pendingParams = new Map<string, { params: GenerationParams; resolvedSeed: number; assembledPos: string; assembledNeg: string; createdAt: number }>();
  private recentlyCompleted = new Map<string, RecentlyCompletedEntry>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private activePromptId: string | null = null;

  constructor() {
    this.clientId = uuidv4();
    this.connect();
  }

  private connect() {
    const url = `${COMFYUI_WS}/ws?clientId=${this.clientId}`;
    console.log(`[ComfyWS] Connecting → ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (this.reconnectAttempts > 0) {
        void this.flushJobsOnReconnect();
      }
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log('[ComfyWS] Connected');
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          this.onBinary(data as Buffer);
        } else {
          this.onText(data.toString());
        }
      } catch (err) {
        console.error('[ComfyWS] message error', err);
      }
    });

    ws.on('close', () => {
      this.connected = false;
      console.log('[ComfyWS] Disconnected — will reconnect in 4s');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[ComfyWS] Error:', err.message);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 4000);
  }

  private async flushJobsOnReconnect() {
    const promptIds = [...this.jobs.keys()];
    for (const promptId of promptIds) {
      const job = this.jobs.get(promptId);
      if (!job) continue;
      try {
        const res = await fetch(`${COMFYUI_HTTP}/history/${promptId}`, {
          signal: AbortSignal.timeout(5000),
        });
        const history = await res.json() as Record<string, { status?: { status_str?: string } }>;
        const statusStr = history[promptId]?.status?.status_str;

        if (statusStr === 'success') {
          // Prompt finished during disconnect; binary/video frame was sent into the dead socket.
          job.finalized = true;
          if (job.timeoutId !== null) clearTimeout(job.timeoutId);
          if (this.activePromptId === promptId) this.activePromptId = null;
          const msg = 'Generation completed during reconnection but the output was lost. Please retry.';
          this.addToRecentlyCompleted(job, 'error', msg);
          pushSSE(job.controller, 'error', { message: msg });
          closeSSE(job.controller);
          this.jobs.delete(promptId);
        } else if (statusStr === 'error') {
          job.finalized = true;
          if (job.timeoutId !== null) clearTimeout(job.timeoutId);
          if (this.activePromptId === promptId) this.activePromptId = null;
          const msg = 'Generation failed on the GPU server.';
          this.addToRecentlyCompleted(job, 'error', msg);
          pushSSE(job.controller, 'error', { message: msg });
          closeSSE(job.controller);
          this.jobs.delete(promptId);
        }
      } catch {
        // /history fetch failed — leave job in place and let the watchdog handle it.
      }
    }
  }

  private onBinary(buf: Buffer) {
    const result = parseImageFrame(buf);
    if (!result) return;

    if (result.format === 'jpeg') {
      // TODO: forward to 'preview' SSE event when live previews are wired up (see CLAUDE.md)
      return;
    }

    // Route PNG frame directly to the active prompt — no iteration needed.
    // Video jobs don't emit binary frames; this path is image-only.
    if (this.activePromptId === null) return;
    const job = this.jobs.get(this.activePromptId);
    if (!job || job.mediaType !== 'image') return;
    job.imageBuffers.push(Buffer.from(result.image));
  }

  private onText(raw: string) {
    let msg: { type: string; data: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { type, data } = msg;

    if (type === 'status') return; // ignore heartbeats

    if (type === 'progress') {
      const job = this.jobs.get(data.prompt_id as string);
      if (job) {
        job.progress = { current: data.value as number, total: data.max as number };
        pushSSE(job.controller, 'progress', { value: data.value, max: data.max });
      }
      return;
    }

    if (type === 'executing') {
      const promptId = data.prompt_id as string;
      const job = this.jobs.get(promptId);
      if (job) {
        const node = (data.node as string | null) ?? null;
        if (node === null) {
          // Older ComfyUI / some forks use executing{node:null} as the end-of-prompt sentinel
          this.activePromptId = null;
          this.finalizeJob(job);
        } else {
          // First non-null executing message: ComfyUI has dequeued this prompt and started GPU work.
          if (job.runningSince === null) job.runningSince = Date.now();
          this.activePromptId = promptId;
          job.activeNode = node;
        }
      }
      return;
    }

    if (type === 'executed') {
      // ComfyUI sends this when a node finishes with output. For video jobs, SaveWEBM
      // reports the output file here (not over binary WS like SaveImageWebsocket does).
      const promptId = data.prompt_id as string;
      const job = this.jobs.get(promptId);
      if (job && job.mediaType === 'video') {
        const output = data.output as Record<string, Array<{ filename: string; subfolder: string }>> | undefined;
        if (output) {
          // ComfyUI's choice of key (videos/images/gifs) depends on the save node and build version
          const fileList = output.videos ?? output.images ?? output.gifs;
          if (fileList?.[0]) {
            job.videoResult = { filename: fileList[0].filename, subfolder: fileList[0].subfolder };
          }
        }
      }
      return;
    }

    if (type === 'execution_success') {
      const promptId = data.prompt_id as string;
      const job = this.jobs.get(promptId);
      if (job) {
        if (this.activePromptId === promptId) this.activePromptId = null;
        this.finalizeJob(job);
      }
      return;
    }

    if (type === 'execution_error') {
      const promptId = data.prompt_id as string;
      const job = this.jobs.get(promptId);
      if (job) {
        job.finalized = true;
        if (job.timeoutId !== null) clearTimeout(job.timeoutId);
        if (this.activePromptId === promptId) this.activePromptId = null;
        const message = data.exception_message != null ? String(data.exception_message) : 'Generation failed';
        this.addToRecentlyCompleted(job, 'error', message);
        pushSSE(job.controller, 'error', { message });
        closeSSE(job.controller);
        this.jobs.delete(promptId);
        // For video jobs: still attempt SSH cleanup even on error
        if (job.mediaType === 'video') {
          void this.sshCleanupVideo(job.videoParams.filenamePrefix);
        }
      }
      return;
    }
  }

  private finalizeJob(job: Job) {
    if (job.finalized) return;
    // Signal to the client that GPU computation is done and file saving is starting
    pushSSE(job.controller, 'completing', {});
    if (job.mediaType === 'video') {
      void this.finalizeVideoJob(job);
    } else if (job.mediaType === 'image') {
      void this.finalizeImageJob(job);
    }
    // stitch jobs finalize via finalizeStitchSuccess/Error — not through this path
  }

  private async finalizeImageJob(job: ImageJob) {
    job.finalized = true;
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    const { params, resolvedSeed, assembledPos, assembledNeg, imageBuffers, controller } = job;
    this.jobs.delete(job.promptId);

    if (imageBuffers.length === 0) {
      this.addToRecentlyCompleted(job, 'error', 'No image data received');
      pushSSE(controller, 'error', { message: 'No image data received' });
      closeSSE(controller);
      return;
    }

    try {
      const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
      if (!IMAGE_OUTPUT_DIR) {
        throw new Error('IMAGE_OUTPUT_DIR not configured. Set it in .env to an absolute path outside the repo.');
      }
      const dir = IMAGE_OUTPUT_DIR;
      await mkdir(dir, { recursive: true });

      const slug = slugifyPrompt(params.positivePrompt);
      const timestamp = Date.now();

      const loraStr = params.loras.length > 0
        ? params.loras.map((l) => `${l.name} (${l.weight.toFixed(2)})`).join(', ')
        : null;
      const lorasJsonValue = params.loras.length > 0
        ? (params.loras as unknown as Prisma.InputJsonValue)
        : undefined;

      const records = await Promise.all(
        imageBuffers.map(async (buf) => {
          const ext = 'png'; // SaveImageWebsocket always emits PNG; only PNG frames reach imageBuffers
          // Use promptId prefix for collision-free filenames — batch takes submitted in the same
          // millisecond share a timestamp, so slug+timestamp alone is not unique.
          const filename = `${slug}_${timestamp}_${job.promptId.slice(0, 8)}.${ext}`;

          await writeFile(path.join(dir, filename), buf);
          const filePath = `/api/images/${filename}`;

          const record = await prisma.generation.create({
            data: {
              filePath,
              promptPos: params.positivePrompt,
              promptNeg: params.negativePrompt,
              model: params.checkpoint,
              lora: loraStr,
              lorasJson: lorasJsonValue,
              assembledPos,
              assembledNeg,
              seed: BigInt(resolvedSeed),
              cfg: params.cfg,
              steps: params.steps,
              width: params.width,
              height: params.height,
              sampler: params.sampler,
              scheduler: params.scheduler,
              highResFix: params.highResFix ?? false,
              mediaType: 'image',
            },
          });

          return {
            ...record,
            seed: record.seed.toString(),
            createdAt: record.createdAt.toISOString(),
          };
        }),
      );

      this.addToRecentlyCompleted(job, 'done', undefined, records[0].id);
      pushSSE(controller, 'complete', { records });
    } catch (err) {
      console.error('[ComfyWS] finalizeImageJob error', err);
      this.addToRecentlyCompleted(job, 'error', String(err));
      pushSSE(controller, 'error', { message: String(err) });
    } finally {
      closeSSE(controller);
    }
  }

  private async finalizeVideoJob(job: VideoJob) {
    job.finalized = true;
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    const { videoParams, videoResult, controller } = job;
    this.jobs.delete(job.promptId);

    try {
      if (!videoResult) {
        throw new Error('No video output received from ComfyUI (SaveWEBM did not report a file)');
      }

      const { filename, subfolder } = videoResult;

      // Fetch video file from ComfyUI /view — it lives on the VM's output folder
      const viewUrl = new URL(`${COMFYUI_HTTP}/view`);
      viewUrl.searchParams.set('filename', filename);
      viewUrl.searchParams.set('subfolder', subfolder);
      viewUrl.searchParams.set('type', 'output');

      const videoRes = await fetch(viewUrl.toString(), {
        signal: AbortSignal.timeout(120_000), // 2-min timeout for file transfer
      });
      if (!videoRes.ok) {
        throw new Error(`ComfyUI /view returned ${videoRes.status} ${videoRes.statusText}`);
      }
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // Write to local storage alongside image files
      await mkdir(videoParams.outputDir, { recursive: true });

      const slug = slugifyPrompt(videoParams.prompt);
      const localFilename = `${slug}_${Date.now()}.webm`;
      await writeFile(path.join(videoParams.outputDir, localFilename), videoBuffer);
      const filePath = `/api/images/${localFilename}`;

      // Compute position for project clips
      let position: number | undefined;
      if (videoParams.projectId) {
        const maxResult = await prisma.generation.aggregate({
          where: { projectId: videoParams.projectId },
          _max: { position: true },
        });
        position = (maxResult._max.position ?? 0) + 1;
      }

      // Create DB row
      const record = await prisma.generation.create({
        data: {
          id: videoParams.generationId,
          filePath,
          promptPos: videoParams.prompt,
          promptNeg: videoParams.negativePrompt,
          model: videoParams.lightning ? `wan2.2-${videoParams.mode}-lightning` : `wan2.2-${videoParams.mode}`,
          seed: BigInt(videoParams.seed),
          cfg: videoParams.cfg,
          steps: videoParams.steps,
          width: videoParams.width,
          height: videoParams.height,
          sampler: videoParams.lightning ? 'lcm' : 'euler',
          scheduler: 'simple',
          highResFix: false,
          mediaType: 'video',
          frames: videoParams.frames,
          fps: 16,
          ...(videoParams.projectId ? { projectId: videoParams.projectId, position } : {}),
        },
      });

      this.addToRecentlyCompleted(job, 'done', undefined, record.id);
      pushSSE(controller, 'complete', {
        id: record.id,
        filePath: record.filePath,
        frames: record.frames,
        fps: record.fps,
        seed: record.seed.toString(),
        createdAt: record.createdAt.toISOString(),
      });
    } catch (err) {
      console.error('[ComfyWS] finalizeVideoJob error', err);
      this.addToRecentlyCompleted(job, 'error', String(err));
      pushSSE(controller, 'error', { message: String(err) });
    } finally {
      // SSH cleanup always runs — globs by prefix so partial files are removed too
      await this.sshCleanupVideo(videoParams.filenamePrefix);
      closeSSE(controller);
    }
  }

  private async sshCleanupVideo(filenamePrefix: string) {
    if (!/^[a-f0-9]{16}$/.test(filenamePrefix)) {
      throw new Error(`sshCleanupVideo: invalid filenamePrefix "${filenamePrefix}" — expected 16 hex chars`);
    }
    if (!VM_IP || !VM_USER || !SSH_KEY_PATH) {
      console.warn('[ComfyWS] SSH cleanup skipped — VM credentials not configured');
      return;
    }
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
      await ssh.execCommand(`rm -f ${COMFYUI_OUTPUT_PATH}/${filenamePrefix}*`);
    } catch (err) {
      // SSH cleanup failure is non-fatal — file is small and can be cleaned manually
      console.error('[ComfyWS] SSH cleanup error', err);
    } finally {
      ssh.dispose();
    }
  }

  private expireJob(promptId: string) {
    const job = this.jobs.get(promptId);
    if (!job || job.finalized) return;
    job.finalized = true;
    job.timeoutId = null;
    if (this.activePromptId === promptId) this.activePromptId = null;
    const mins = job.mediaType === 'video' ? 15 : job.mediaType === 'stitch' ? 5 : 10;
    const message = `Generation timed out after ${mins} minutes`;
    this.addToRecentlyCompleted(job, 'error', message);
    pushSSE(job.controller, 'error', { message });
    closeSSE(job.controller);
    this.jobs.delete(promptId);
    if (job.mediaType === 'video') {
      void this.sshCleanupVideo(job.videoParams.filenamePrefix);
    } else if (job.mediaType === 'stitch') {
      if (job.childProcess && !job.childProcess.killed) job.childProcess.kill('SIGTERM');
      void unlink(job.outputPath).catch(() => {});
    }
  }

  private addToRecentlyCompleted(
    job: Job,
    status: 'done' | 'error',
    errorMessage?: string,
    generationId?: string,
  ) {
    const defaultId =
      job.mediaType === 'video' ? job.videoParams.generationId :
      job.mediaType === 'stitch' ? job.generationId : '';
    const entry: RecentlyCompletedEntry = {
      promptId: job.promptId,
      generationId: generationId ?? defaultId,
      mediaType: job.mediaType,
      promptSummary: job.promptSummary,
      status,
      errorMessage,
      completedAt: Date.now(),
    };
    this.recentlyCompleted.set(job.promptId, entry);
  }

  stashJobParams(
    promptId: string,
    params: GenerationParams,
    resolvedSeed: number,
    assembledPos: string,
    assembledNeg: string,
  ) {
    // TTL purge: drop stale entries from tabs that closed before opening SSE
    const now = Date.now();
    for (const [id, entry] of this.pendingParams) {
      if (now - entry.createdAt > 60_000) this.pendingParams.delete(id);
    }

    // Strip baseImage and denoise — not needed in finalizeImageJob, and baseImage can be several MB
    const { baseImage: _bi, denoise: _d, ...rest } = params;
    this.pendingParams.set(promptId, { params: rest as GenerationParams, resolvedSeed, assembledPos, assembledNeg, createdAt: now });
  }

  registerJob(
    promptId: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    const entry = this.pendingParams.get(promptId);
    this.pendingParams.delete(promptId);

    if (!entry) {
      controller.enqueue(sseChunk('error', { message: 'Job parameters expired or not found' }));
      try { controller.close(); } catch { /* already closed */ }
      return;
    }

    const timeoutId = setTimeout(() => this.expireJob(promptId), IMAGE_JOB_TIMEOUT_MS);
    const promptSummary = entry.params.positivePrompt.slice(0, 60).trim() || 'Image generation';

    this.jobs.set(promptId, {
      promptId,
      mediaType: 'image',
      params: entry.params,
      resolvedSeed: entry.resolvedSeed,
      assembledPos: entry.assembledPos,
      assembledNeg: entry.assembledNeg,
      controller,
      imageBuffers: [],
      activeNode: null,
      finalized: false,
      timeoutId,
      promptSummary,
      startedAt: Date.now(),
      runningSince: null,
      progress: null,
    });
  }

  registerVideoJob(
    promptId: string,
    videoParams: VideoJobParams,
    controller: ReadableStreamDefaultController<Uint8Array>,
    timeoutMs = VIDEO_JOB_TIMEOUT_MS,
  ) {
    const timeoutId = setTimeout(() => this.expireJob(promptId), timeoutMs);
    const promptSummary = videoParams.prompt.slice(0, 60).trim() || 'Video generation';

    this.jobs.set(promptId, {
      promptId,
      mediaType: 'video',
      videoParams,
      controller,
      imageBuffers: [],
      activeNode: null,
      finalized: false,
      timeoutId,
      promptSummary,
      startedAt: Date.now(),
      runningSince: null,
      progress: null,
    });
  }

  /**
   * Explicit user abort. Cancels the watchdog, SSH-cleans any VM video file,
   * adds a recentlyCompleted error entry, pushes an abort event to any live
   * subscriber, and removes the job from the active map.
   *
   * Only called by the POST /api/jobs/[promptId]/abort endpoint — never by
   * SSE stream-close handlers (those call removeSubscriber instead).
   */
  abortJob(promptId: string): boolean {
    const job = this.jobs.get(promptId);
    if (!job) return false;
    if (job.timeoutId != null) clearTimeout(job.timeoutId);

    if (job.mediaType === 'stitch') {
      // Kill the ffmpeg child process; delete the partial output file.
      // The route's catch block will also attempt cleanup (idempotent).
      if (job.childProcess && !job.childProcess.killed) {
        job.childProcess.kill('SIGTERM');
      }
      void unlink(job.outputPath).catch(() => {});
    } else if (job.runningSince === null) {
      // Job is still in ComfyUI's queue (not yet executing). Use the queue-delete
      // API to remove it without killing whatever is actually running on the GPU.
      fetch(`${COMFYUI_HTTP}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      }).catch((err) => {
        console.error(`[comfyws] /queue delete failed for ${promptId}:`, err);
      });
    } else {
      // Job is actively executing on the GPU. /interrupt is workflow-global —
      // it cancels whatever is at the head of ComfyUI's queue (our running job).
      fetch(`${COMFYUI_HTTP}/interrupt`, { method: 'POST' }).catch((err) => {
        console.error(`[comfyws] /interrupt failed for ${promptId}:`, err);
      });

      // If this is a video job that hasn't been finalized, the file may have been
      // (or be about to be) written to the VM. Fire-and-forget SSH cleanup; the
      // glob is idempotent and will no-op if no file exists yet.
      if (job.mediaType === 'video' && !job.finalized) {
        this.sshCleanupVideo(job.videoParams.filenamePrefix).catch((err) => {
          console.error(`[ComfyWS] SSH cleanup failed for aborted job ${promptId}:`, err);
        });
      }
    }

    // Notify any live SSE subscriber, then close that stream.
    // For post-refresh polling the recentlyCompleted cache entry covers recovery.
    this.addToRecentlyCompleted(job, 'error', 'Aborted by user');
    pushSSE(job.controller, 'error', { message: 'Aborted by user' });
    closeSSE(job.controller);

    this.jobs.delete(promptId);
    return true;
  }

  /**
   * Detaches the SSE controller from its job when the client disconnects
   * (browser refresh, tab close, network drop). The job continues running
   * on the VM — the watchdog still ticks, finalization still writes to DB
   * and recentlyCompleted. The next /api/jobs/active poll will surface the
   * job status to any reconnected client.
   *
   * SSE stream close ≠ user intent. Never call abortJob from stream-close
   * handlers — that conflates "refreshed" with "cancelled" and breaks refresh
   * survivability.
   */
  removeSubscriber(
    promptId: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const job = this.jobs.get(promptId);
    if (job && job.controller === controller) {
      job.controller = null;
    }
    // Job stays in the map. Watchdog still ticks. Completion still fires.
  }

  /** Returns all active (queued/running) jobs plus recently-completed jobs (within 5 min). */
  getActiveJobs(): ActiveJobInfo[] {
    const now = Date.now();
    const result: ActiveJobInfo[] = [];

    // Active jobs (queued or running)
    for (const job of this.jobs.values()) {
      if (!job.finalized) {
        const generationId =
          job.mediaType === 'video' ? job.videoParams.generationId :
          job.mediaType === 'stitch' ? job.generationId : '';
        result.push({
          promptId: job.promptId,
          generationId,
          mediaType: job.mediaType,
          promptSummary: job.promptSummary,
          startedAt: job.startedAt,
          runningSince: job.runningSince,
          progress: job.progress,
          // Stitch jobs start ffmpeg immediately; no ComfyUI queue involved.
          status: job.mediaType === 'stitch' || job.runningSince !== null ? 'running' : 'queued',
        });
      }
    }

    // Recently-completed jobs (for client poll-based recovery)
    const expiredKeys: string[] = [];
    for (const [key, entry] of this.recentlyCompleted) {
      if (now - entry.completedAt > RECENT_COMPLETED_TTL_MS) {
        expiredKeys.push(key);
      } else {
        result.push({
          promptId: entry.promptId,
          generationId: entry.generationId,
          mediaType: entry.mediaType,
          promptSummary: entry.promptSummary,
          startedAt: 0,
          runningSince: null,
          progress: null,
          status: entry.status,
          errorMessage: entry.errorMessage,
        });
      }
    }
    for (const key of expiredKeys) this.recentlyCompleted.delete(key);

    return result;
  }

  // ─── stitch job management ────────────────────────────────────────────────

  registerStitchJob(
    promptId: string,
    generationId: string,
    outputPath: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
    promptSummary: string,
    timeoutMs = STITCH_JOB_TIMEOUT_MS,
    projectId?: string,
  ) {
    const timeoutId = setTimeout(() => this.expireJob(promptId), timeoutMs);
    this.jobs.set(promptId, {
      promptId,
      mediaType: 'stitch',
      generationId,
      outputPath,
      childProcess: null,
      controller,
      imageBuffers: [],
      activeNode: null,
      finalized: false,
      timeoutId,
      promptSummary,
      startedAt: Date.now(),
      runningSince: Date.now(), // ffmpeg starts immediately; no ComfyUI queue
      progress: null,
      projectId,
    });
  }

  setStitchProcess(promptId: string, cp: ChildProcessWithoutNullStreams) {
    const job = this.jobs.get(promptId);
    if (job && job.mediaType === 'stitch') job.childProcess = cp;
  }

  updateStitchProgress(promptId: string, progress: { current: number; total: number }) {
    const job = this.jobs.get(promptId);
    if (job && job.mediaType === 'stitch') {
      job.progress = progress;
      pushSSE(job.controller, 'progress', { value: progress.current, max: progress.total });
    }
  }

  finalizeStitchSuccess(
    promptId: string,
    generationId: string,
    data: { id: string; filePath: string; frames: number | null; fps: number | null; width?: number; height?: number; seed: string; createdAt: string },
  ) {
    const job = this.jobs.get(promptId);
    if (!job || job.mediaType !== 'stitch' || job.finalized) return;
    job.finalized = true;
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    this.jobs.delete(promptId);
    this.addToRecentlyCompleted(job, 'done', undefined, generationId);
    pushSSE(job.controller, 'completing', {});
    pushSSE(job.controller, 'complete', data);
    closeSSE(job.controller);
  }

  finalizeStitchError(promptId: string, message: string) {
    const job = this.jobs.get(promptId);
    if (!job || job.mediaType !== 'stitch' || job.finalized) return; // no-op if already aborted
    job.finalized = true;
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    this.jobs.delete(promptId);
    this.addToRecentlyCompleted(job, 'error', message);
    pushSSE(job.controller, 'error', { message });
    closeSSE(job.controller);
  }

  /**
   * Abort all active jobs associated with a project (fire-and-forget, for cascade delete).
   * Returns the promptIds of aborted jobs.
   */
  abortJobsByProjectId(projectId: string): string[] {
    const aborted: string[] = [];
    for (const [promptId, job] of this.jobs) {
      const matches =
        (job.mediaType === 'video' && job.videoParams.projectId === projectId) ||
        (job.mediaType === 'stitch' && job.projectId === projectId);
      if (matches) {
        this.abortJob(promptId);
        aborted.push(promptId);
      }
    }
    return aborted;
  }

  getClientId() {
    return this.clientId;
  }

  isConnected() {
    return this.connected;
  }
}

// ─── singleton ───────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __comfyWSManager: ComfyWSManager | undefined;
}

export function getComfyWSManager(): ComfyWSManager {
  if (!global.__comfyWSManager) {
    global.__comfyWSManager = new ComfyWSManager();
  }
  return global.__comfyWSManager;
}
