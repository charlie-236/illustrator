import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { NodeSSH } from 'node-ssh';
import { buildT2VWorkflow, buildI2VWorkflow } from '@/lib/wan22-workflow';
import { getComfyWSManager } from '@/lib/comfyws';
import { prisma } from '@/lib/prisma';
import type { ComfyWorkflow } from '@/lib/wan22-workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';
const VIDEO_JOB_TIMEOUT_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function validateVideoWorkflow(wf: ComfyWorkflow): void {
  for (const [nodeId, node] of Object.entries(wf)) {
    const cls = node.class_type;
    if (cls === 'SaveImage') throw new Error(`SaveImage forbidden (node ${nodeId})`);
    if (cls === 'LoadImage') throw new Error(`LoadImage forbidden — use ETN_LoadImageBase64 (node ${nodeId})`);
    if (cls === 'SaveAnimatedWEBP') throw new Error(`SaveAnimatedWEBP should have been stripped (node ${nodeId})`);
  }
}

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 30)
    .replace(/_+$/, '');
  return slug || 'video';
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  function bad(msg: string) {
    return Response.json({ error: msg }, { status: 400 });
  }

  if (b.mode !== 't2v' && b.mode !== 'i2v') {
    return bad("mode must be 't2v' or 'i2v'");
  }
  const mode = b.mode as 't2v' | 'i2v';

  if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
    return bad('prompt must be a non-empty string');
  }
  const prompt = b.prompt.trim();

  if (b.negativePrompt !== undefined && typeof b.negativePrompt !== 'string') {
    return bad('negativePrompt must be a string if provided');
  }
  const negativePrompt = b.negativePrompt as string | undefined;

  if (
    !Number.isInteger(b.width) ||
    (b.width as number) < 256 ||
    (b.width as number) > 1280 ||
    (b.width as number) % 32 !== 0
  ) {
    return bad('width must be an integer multiple of 32 between 256 and 1280');
  }
  const width = b.width as number;

  if (
    !Number.isInteger(b.height) ||
    (b.height as number) < 256 ||
    (b.height as number) > 1280 ||
    (b.height as number) % 32 !== 0
  ) {
    return bad('height must be an integer multiple of 32 between 256 and 1280');
  }
  const height = b.height as number;

  if (
    !Number.isInteger(b.frames) ||
    (b.frames as number) < 17 ||
    (b.frames as number) > 121 ||
    ((b.frames as number) - 1) % 8 !== 0
  ) {
    return bad('frames must be an integer where (frames - 1) % 8 === 0, between 17 and 121 (e.g. 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121)');
  }
  const frames = b.frames as number;

  if (
    !Number.isInteger(b.steps) ||
    (b.steps as number) < 4 ||
    (b.steps as number) > 40 ||
    (b.steps as number) % 2 !== 0
  ) {
    return bad('steps must be an even integer between 4 and 40');
  }
  const steps = b.steps as number;

  if (
    typeof b.cfg !== 'number' ||
    !Number.isFinite(b.cfg) ||
    (b.cfg as number) < 1.0 ||
    (b.cfg as number) > 10.0
  ) {
    return bad('cfg must be a number between 1.0 and 10.0');
  }
  const cfg = b.cfg as number;

  const seed =
    b.seed !== undefined && Number.isInteger(b.seed)
      ? (b.seed as number)
      : Math.floor(Math.random() * 2 ** 32);

  if (mode === 'i2v' && (typeof b.startImageB64 !== 'string' || b.startImageB64.length === 0)) {
    return bad("startImageB64 is required for mode='i2v'");
  }
  if (mode === 't2v' && b.startImageB64 !== undefined) {
    return bad("startImageB64 is forbidden for mode='t2v'");
  }
  const startImageB64 = b.startImageB64 as string | undefined;

  // Unique ID used in filename_prefix (enables glob-based SSH cleanup)
  const generationId = crypto.randomUUID();

  const workflow =
    mode === 't2v'
      ? buildT2VWorkflow({ generationId, prompt, negativePrompt, width, height, frames, steps, cfg, seed })
      : buildI2VWorkflow({ generationId, prompt, negativePrompt, width, height, frames, steps, cfg, seed, startImageB64: startImageB64! });

  try {
    validateVideoWorkflow(workflow);
  } catch (err) {
    console.error('[generate-video] workflow guard failed:', err);
    return Response.json(
      { error: `Internal error: ${String(err)}. This is a bug.` },
      { status: 500 },
    );
  }

  const manager = getComfyWSManager();

  let comfyRes: Response;
  try {
    comfyRes = await fetch(`${COMFYUI}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: manager.getClientId() }),
    });
  } catch (err) {
    return Response.json({ error: `ComfyUI unreachable: ${String(err)}` }, { status: 502 });
  }

  if (!comfyRes.ok) {
    const errBody = await comfyRes.text();
    return Response.json({ error: errBody }, { status: comfyRes.status });
  }

  const { prompt_id: promptId } = (await comfyRes.json()) as { prompt_id: string };
  if (!promptId) {
    return Response.json({ error: 'No prompt_id in ComfyUI response' }, { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      manager.registerVideoJob(
        promptId,
        controller,
        // Called by comfyws when SaveWEBM (node 47) reports its output via 'executed' event.
        async (filename, subfolder) => {
          try {
            const viewUrl = new URL(`${COMFYUI}/view`);
            viewUrl.searchParams.set('filename', filename);
            viewUrl.searchParams.set('subfolder', subfolder);
            viewUrl.searchParams.set('type', 'output');

            const videoRes = await fetch(viewUrl.toString());
            if (!videoRes.ok) {
              throw new Error(`ComfyUI /view returned ${videoRes.status}: ${await videoRes.text()}`);
            }

            const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

            const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
            if (!IMAGE_OUTPUT_DIR) {
              throw new Error('IMAGE_OUTPUT_DIR not configured');
            }

            await mkdir(IMAGE_OUTPUT_DIR, { recursive: true });
            const slug = slugifyPrompt(prompt);
            const timestamp = Date.now();
            const webmFilename = `${slug}_${timestamp}.webm`;
            await writeFile(path.join(IMAGE_OUTPUT_DIR, webmFilename), videoBuffer);
            const filePath = `/api/images/${webmFilename}`;

            const record = await prisma.generation.create({
              data: {
                filePath,
                promptPos: prompt,
                promptNeg: negativePrompt ?? '',
                model: 'wan2.2-14b-fp8',
                seed: BigInt(seed),
                cfg,
                steps,
                width,
                height,
                sampler: 'euler',
                scheduler: 'simple',
                highResFix: false,
                mediaType: 'video',
                frames,
                fps: 16,
              },
            });

            controller.enqueue(
              sseChunk('complete', {
                records: [{ ...record, seed: record.seed.toString(), createdAt: record.createdAt.toISOString() }],
              }),
            );
          } catch (err) {
            console.error('[generate-video] completion error:', err);
            controller.enqueue(sseChunk('error', { message: String(err) }));
          } finally {
            // SSH cleanup — remove the webm from the VM regardless of success or failure.
            // Failure here is non-fatal; log and continue.
            if (SSH_KEY_PATH && VM_USER && VM_IP) {
              const ssh = new NodeSSH();
              try {
                await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
                await ssh.execCommand(`rm -f /models/ComfyUI/output/video-${generationId}*`);
              } catch (sshErr) {
                console.error('[generate-video] SSH cleanup failed:', sshErr);
              } finally {
                ssh.dispose();
              }
            }
            try { controller.close(); } catch { /* already closed */ }
          }
        },
        VIDEO_JOB_TIMEOUT_MS,
      );

      req.signal.addEventListener('abort', () => {
        manager.removeJob(promptId);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
