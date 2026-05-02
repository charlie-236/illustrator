import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Prisma } from '@prisma/client';
import type { GenerationParams } from '@/types';
import { NodeSSH } from 'node-ssh';
import { prisma } from './prisma';

// ─── job types ───────────────────────────────────────────────────────────────

export interface VideoJobParams {
  generationId: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;
  mode: 't2v' | 'i2v';
}

interface BaseJob {
  promptId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Image frames accumulate here for image jobs; always empty for video jobs. */
  imageBuffers: Buffer[];
  activeNode: string | null;
  finalized: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
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

type Job = ImageJob | VideoJob;

// ─── constants ───────────────────────────────────────────────────────────────

const COMFYUI_WS = process.env.COMFYUI_WS_URL ?? 'ws://127.0.0.1:8188';
const COMFYUI_HTTP = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
const IMAGE_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — covers batch=4 + high-res on A100
const VIDEO_JOB_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — Wan 2.2 at 1280×704 takes ~5 min; 15 gives headroom
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

const encoder = new TextEncoder();

// ─── helpers ─────────────────────────────────────────────────────────────────

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
          job.controller.enqueue(sseChunk('error', {
            message: 'Generation completed during reconnection but the output was lost. Please retry.',
          }));
          try { job.controller.close(); } catch { /* already closed */ }
          this.jobs.delete(promptId);
        } else if (statusStr === 'error') {
          job.finalized = true;
          if (job.timeoutId !== null) clearTimeout(job.timeoutId);
          if (this.activePromptId === promptId) this.activePromptId = null;
          job.controller.enqueue(sseChunk('error', {
            message: 'Generation failed on the GPU server.',
          }));
          try { job.controller.close(); } catch { /* already closed */ }
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
        job.controller.enqueue(
          sseChunk('progress', { value: data.value, max: data.max }),
        );
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
        job.controller.enqueue(sseChunk('error', { message }));
        try { job.controller.close(); } catch { /* already closed */ }
        this.jobs.delete(promptId);
        // For video jobs: still attempt SSH cleanup even on error
        if (job.mediaType === 'video') {
          void this.sshCleanupVideo(job.videoParams.generationId);
        }
      }
      return;
    }
  }

  private finalizeJob(job: Job) {
    if (job.finalized) return;
    if (job.mediaType === 'video') {
      void this.finalizeVideoJob(job);
    } else {
      void this.finalizeImageJob(job);
    }
  }

  private async finalizeImageJob(job: ImageJob) {
    job.finalized = true;
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    const { params, resolvedSeed, assembledPos, assembledNeg, imageBuffers, controller } = job;
    this.jobs.delete(job.promptId);

    if (imageBuffers.length === 0) {
      controller.enqueue(sseChunk('error', { message: 'No image data received' }));
      try { controller.close(); } catch { /* already closed */ }
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
      const isBatch = imageBuffers.length > 1;

      const loraStr = params.loras.length > 0
        ? params.loras.map((l) => `${l.name} (${l.weight.toFixed(2)})`).join(', ')
        : null;
      const lorasJsonValue = params.loras.length > 0
        ? (params.loras as unknown as Prisma.InputJsonValue)
        : undefined;

      const records = await Promise.all(
        imageBuffers.map(async (buf, i) => {
          const ext = 'png'; // SaveImageWebsocket always emits PNG; only PNG frames reach imageBuffers
          const filename = isBatch
            ? `${slug}_${timestamp}_${i + 1}.${ext}`
            : `${slug}_${timestamp}.${ext}`;

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

      controller.enqueue(sseChunk('complete', { records }));
    } catch (err) {
      console.error('[ComfyWS] finalizeImageJob error', err);
      controller.enqueue(sseChunk('error', { message: String(err) }));
    } finally {
      try { job.controller.close(); } catch { /* already closed */ }
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
      const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
      if (!IMAGE_OUTPUT_DIR) {
        throw new Error('IMAGE_OUTPUT_DIR not configured');
      }
      await mkdir(IMAGE_OUTPUT_DIR, { recursive: true });

      const slug = slugifyPrompt(videoParams.prompt);
      const localFilename = `${slug}_${Date.now()}.webm`;
      await writeFile(path.join(IMAGE_OUTPUT_DIR, localFilename), videoBuffer);
      const filePath = `/api/images/${localFilename}`;

      // Create DB row
      const record = await prisma.generation.create({
        data: {
          id: videoParams.generationId,
          filePath,
          promptPos: videoParams.prompt,
          promptNeg: videoParams.negativePrompt,
          model: `wan2.2-${videoParams.mode}`,
          seed: BigInt(videoParams.seed),
          cfg: videoParams.cfg,
          steps: videoParams.steps,
          width: videoParams.width,
          height: videoParams.height,
          sampler: 'euler',
          scheduler: 'simple',
          highResFix: false,
          mediaType: 'video',
          frames: videoParams.frames,
          fps: 16,
        },
      });

      controller.enqueue(sseChunk('complete', {
        id: record.id,
        filePath: record.filePath,
        frames: record.frames,
        fps: record.fps,
        seed: record.seed.toString(),
        createdAt: record.createdAt.toISOString(),
      }));
    } catch (err) {
      console.error('[ComfyWS] finalizeVideoJob error', err);
      controller.enqueue(sseChunk('error', { message: String(err) }));
    } finally {
      // SSH cleanup always runs — globs by prefix so partial files are removed too
      await this.sshCleanupVideo(videoParams.generationId);
      try { controller.close(); } catch { /* already closed */ }
    }
  }

  private async sshCleanupVideo(generationId: string) {
    if (!VM_IP || !VM_USER || !SSH_KEY_PATH) {
      console.warn('[ComfyWS] SSH cleanup skipped — VM credentials not configured');
      return;
    }
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
      await ssh.execCommand(`rm -f /models/ComfyUI/output/video-${generationId}*`);
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
    const mins = job.mediaType === 'video' ? 15 : 10;
    job.controller.enqueue(sseChunk('error', { message: `Generation timed out after ${mins} minutes` }));
    try { job.controller.close(); } catch { /* already closed */ }
    this.jobs.delete(promptId);
    if (job.mediaType === 'video') {
      void this.sshCleanupVideo(job.videoParams.generationId);
    }
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
    });
  }

  registerVideoJob(
    promptId: string,
    videoParams: VideoJobParams,
    controller: ReadableStreamDefaultController<Uint8Array>,
    timeoutMs = VIDEO_JOB_TIMEOUT_MS,
  ) {
    const timeoutId = setTimeout(() => this.expireJob(promptId), timeoutMs);

    this.jobs.set(promptId, {
      promptId,
      mediaType: 'video',
      videoParams,
      controller,
      imageBuffers: [],
      activeNode: null,
      finalized: false,
      timeoutId,
    });
  }

  removeJob(promptId: string) {
    const job = this.jobs.get(promptId);
    if (job?.timeoutId != null) clearTimeout(job.timeoutId);
    this.jobs.delete(promptId);
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
