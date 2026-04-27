import { NodeSSH } from 'node-ssh';
import { randomBytes } from 'crypto';
import { registerModel, type CivitAIMetadata } from '@/lib/registerModel';

const VM_USER = process.env.A100_VM_USER ?? 'charlie';
const VM_IP = process.env.A100_VM_IP ?? '100.96.99.94';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';
const CIVITAI_TOKEN = process.env.CIVITAI_TOKEN ?? '';
const MIN_FILE_SIZE = 1024 * 1024;

export type IngestPhase =
  | { phase: 'metadata'; status: 'fetching' }
  | { phase: 'metadata'; status: 'ok'; friendlyName: string }
  | { phase: 'download'; status: 'starting'; filename: string; remotePath: string }
  | { phase: 'download'; status: 'ok' }
  | { phase: 'validate'; status: 'checking' }
  | { phase: 'validate'; status: 'ok'; sizeBytes: number }
  | { phase: 'register'; status: 'writing' }
  | { phase: 'register'; status: 'ok' }
  | { phase: 'done'; recordId: string }
  | { phase: 'error'; message: string; orphanPath?: string };

export interface IngestRequest {
  type: 'checkpoint' | 'lora';
  modelId: number;
  parentUrlId: number;
  sourceHostname?: string;
}

export async function* ingestModel(req: IngestRequest): AsyncGenerator<IngestPhase> {
  if (!SSH_KEY_PATH) {
    yield { phase: 'error', message: 'A100_SSH_KEY_PATH not configured' };
    return;
  }
  if (!CIVITAI_TOKEN) {
    yield { phase: 'error', message: 'CIVITAI_TOKEN not configured' };
    return;
  }

  const ssh = new NodeSSH();

  try {
    try {
      await ssh.connect({
        host: VM_IP,
        username: VM_USER,
        privateKeyPath: SSH_KEY_PATH,
      });
    } catch (err) {
      yield { phase: 'error', message: `SSH connection failed: ${String(err)}` };
      return;
    }

    // ── Phase 1: metadata fetch ──────────────────────────────────────────
    yield { phase: 'metadata', status: 'fetching' };

    const curlCmd = `curl -4 -s -H 'Authorization: Bearer ${CIVITAI_TOKEN}' 'https://civitai.com/api/v1/model-versions/${req.modelId}'`;
    const metaResult = await ssh.execCommand(curlCmd);

    if (metaResult.code !== 0) {
      yield { phase: 'error', message: `Metadata fetch failed: ${metaResult.stderr || 'no stderr'}` };
      return;
    }

    let metadata: CivitAIMetadata;
    try {
      metadata = JSON.parse(metaResult.stdout) as CivitAIMetadata;
    } catch {
      yield { phase: 'error', message: `CivitAI returned non-JSON: ${metaResult.stdout.slice(0, 200)}` };
      return;
    }

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      typeof (metadata as Record<string, unknown>).id !== 'number' ||
      typeof metadata.model !== 'object' ||
      metadata.model === null ||
      typeof metadata.model.name !== 'string'
    ) {
      yield {
        phase: 'error',
        message: `CivitAI response missing required fields (id, model.name). Raw: ${metaResult.stdout.slice(0, 200)}`,
      };
      return;
    }

    const friendlyName = (metadata.model!.name ?? metadata.name ?? '').trim() || 'unknown';
    yield { phase: 'metadata', status: 'ok', friendlyName };

    // ── Phase 2: download ────────────────────────────────────────────────
    const stem = randomBytes(6).toString('hex');
    const filename = `${stem}.safetensors`;
    const remotePath =
      req.type === 'lora'
        ? `/models/ComfyUI/models/loras/${filename}`
        : `/models/ComfyUI/models/checkpoints/${filename}`;

    yield { phase: 'download', status: 'starting', filename, remotePath };

    const downloadUrl = `https://civitai.red/api/download/models/${req.modelId}?token=${CIVITAI_TOKEN}`;
    const wgetCmd = `wget -q "${downloadUrl}" -O "${remotePath}"`;
    const downloadResult = await ssh.execCommand(wgetCmd);

    if (downloadResult.code !== 0) {
      // wget may leave a 0-byte ghost file; remove it so ComfyUI doesn't see it
      await ssh.execCommand(`rm -f "${remotePath}"`);
      yield {
        phase: 'error',
        message: `Download failed: ${downloadResult.stderr || 'wget exited non-zero'}`,
      };
      return;
    }
    yield { phase: 'download', status: 'ok' };

    // ── Phase 3: validate ────────────────────────────────────────────────
    yield { phase: 'validate', status: 'checking' };

    const statResult = await ssh.execCommand(`stat -c %s "${remotePath}"`);
    if (statResult.code !== 0) {
      await ssh.execCommand(`rm -f "${remotePath}"`);
      yield {
        phase: 'error',
        message: `Could not stat downloaded file: ${statResult.stderr}`,
      };
      return;
    }

    const sizeBytes = parseInt(statResult.stdout.trim(), 10);
    if (!Number.isFinite(sizeBytes)) {
      await ssh.execCommand(`rm -f "${remotePath}"`);
      yield {
        phase: 'error',
        message: `Could not parse file size: ${statResult.stdout}`,
      };
      return;
    }

    if (sizeBytes < MIN_FILE_SIZE) {
      await ssh.execCommand(`rm -f "${remotePath}"`);
      yield {
        phase: 'error',
        message: `Downloaded file is suspiciously small (${sizeBytes} bytes); likely an error page`,
      };
      return;
    }
    yield { phase: 'validate', status: 'ok', sizeBytes };

    // ── Phase 4: register ────────────────────────────────────────────────
    yield { phase: 'register', status: 'writing' };

    const result = await registerModel({
      filename,
      type: req.type,
      modelId: req.modelId,
      parentUrlId: req.parentUrlId,
      civitaiMetadata: metadata,
      sourceHostname: req.sourceHostname,
    });

    if (!result.ok) {
      yield { phase: 'error', message: result.error, orphanPath: remotePath };
      return;
    }

    yield { phase: 'register', status: 'ok' };
    yield { phase: 'done', recordId: result.record.id };
  } finally {
    ssh.dispose();
  }
}
