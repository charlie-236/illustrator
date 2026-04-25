import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { GenerationParams } from '@/types';

interface Job {
  promptId: string;
  params: GenerationParams;
  resolvedSeed: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  lastImageBuffer: Buffer | null;
  activeNode: string | null;
}

const COMFYUI_WS = process.env.COMFYUI_WS_URL ?? 'ws://localhost:8188';
const encoder = new TextEncoder();

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractImage(buf: Buffer): Buffer | null {
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  const JPEG = [0xff, 0xd8, 0xff];
  const limit = Math.min(buf.length - 4, 32);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === PNG[0] && buf[i + 1] === PNG[1] && buf[i + 2] === PNG[2] && buf[i + 3] === PNG[3]) {
      return buf.subarray(i);
    }
    if (buf[i] === JPEG[0] && buf[i + 1] === JPEG[1] && buf[i + 2] === JPEG[2]) {
      return buf.subarray(i);
    }
  }
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

class ComfyWSManager {
  private ws: WebSocket | null = null;
  private clientId: string;
  private jobs = new Map<string, Job>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnectAttempts = 0;

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
        this.flushJobsOnReconnect();
      }
      this.connected = true;
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

  private flushJobsOnReconnect() {
    for (const job of this.jobs.values()) {
      job.controller.enqueue(
        sseChunk('error', { message: 'Connection lost — please retry' }),
      );
      try { job.controller.close(); } catch { /* already closed */ }
    }
    this.jobs.clear();
  }

  private onBinary(buf: Buffer) {
    const image = extractImage(buf);
    if (!image) return;

    // Binary messages aren't tagged with prompt_id; attach to the actively executing job.
    for (const job of this.jobs.values()) {
      if (job.activeNode !== null) {
        job.lastImageBuffer = image;
        return;
      }
    }
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
      const job = this.jobs.get(data.prompt_id as string);
      if (job) job.activeNode = (data.node as string | null) ?? null;
      return;
    }

    if (type === 'execution_success') {
      const job = this.jobs.get(data.prompt_id as string);
      if (job) this.finalizeJob(job);
      return;
    }

    if (type === 'execution_error') {
      const job = this.jobs.get(data.prompt_id as string);
      if (job) {
        job.controller.enqueue(
          sseChunk('error', { message: data.exception_message ?? 'Generation failed' }),
        );
        try { job.controller.close(); } catch { /* already closed */ }
        this.jobs.delete(data.prompt_id as string);
      }
      return;
    }
  }

  private async finalizeJob(job: Job) {
    const { params, resolvedSeed, lastImageBuffer, controller } = job;
    this.jobs.delete(job.promptId);

    if (!lastImageBuffer) {
      controller.enqueue(sseChunk('error', { message: 'No image data received' }));
      try { controller.close(); } catch { /* already closed */ }
      return;
    }

    try {
      const dir = path.join(process.cwd(), 'public', 'generations');
      await mkdir(dir, { recursive: true });

      const ext = lastImageBuffer[0] === 0x89 ? 'png' : 'jpg';
      const filename = `${slugifyPrompt(params.positivePrompt)}_${Date.now()}.${ext}`;
      await writeFile(path.join(dir, filename), lastImageBuffer);

      const filePath = `/api/images/${filename}`;

      // Lazy-require prisma to avoid issues during cold start
      const { prisma } = await import('./prisma');
      const record = await prisma.generation.create({
        data: {
          filePath,
          promptPos: params.positivePrompt,
          promptNeg: params.negativePrompt,
          model: params.checkpoint,
          lora: params.loras.length > 0
            ? params.loras.map((l) => `${l.name} (${l.weight.toFixed(2)})`).join(', ')
            : null,
          seed: BigInt(resolvedSeed),
          cfg: params.cfg,
          steps: params.steps,
          width: params.width,
          height: params.height,
          sampler: params.sampler,
          scheduler: params.scheduler,
        },
      });

      controller.enqueue(
        sseChunk('complete', { imageUrl: filePath, generationId: record.id }),
      );
    } catch (err) {
      console.error('[ComfyWS] finalizeJob error', err);
      controller.enqueue(sseChunk('error', { message: String(err) }));
    } finally {
      try { job.controller.close(); } catch { /* already closed */ }
    }
  }

  registerJob(
    promptId: string,
    params: GenerationParams,
    resolvedSeed: number,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    this.jobs.set(promptId, {
      promptId,
      params,
      resolvedSeed,
      controller,
      lastImageBuffer: null,
      activeNode: null,
    });
  }

  removeJob(promptId: string) {
    this.jobs.delete(promptId);
  }

  getClientId() {
    return this.clientId;
  }

  isConnected() {
    return this.connected;
  }
}

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
