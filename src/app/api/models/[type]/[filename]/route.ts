import { NextRequest, NextResponse } from 'next/server';
import { NodeSSH } from 'node-ssh';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TYPES = ['checkpoint', 'lora', 'embedding'] as const;
type ModelType = (typeof VALID_TYPES)[number];

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string; filename: string }> },
) {
  const { type, filename } = await params;

  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json(
      { error: `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  if (filename.includes('..') || filename.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid filename: must not contain ".." or "/"' },
      { status: 400 },
    );
  }

  const modelType = type as ModelType;

  const VM_USER = process.env.GPU_VM_USER ?? '';
  const VM_IP = process.env.GPU_VM_IP ?? '';
  const SSH_KEY_PATH = process.env.GPU_VM_SSH_KEY_PATH ?? '';

  if (!VM_USER) {
    return NextResponse.json({ error: 'GPU_VM_USER not configured' }, { status: 500 });
  }
  if (!VM_IP) {
    return NextResponse.json({ error: 'GPU_VM_IP not configured' }, { status: 500 });
  }
  if (!SSH_KEY_PATH) {
    return NextResponse.json({ error: 'GPU_VM_SSH_KEY_PATH not configured' }, { status: 500 });
  }

  const modelsRoot = process.env.COMFYUI_MODELS_ROOT ?? '/models/ComfyUI/models';
  const remotePath =
    modelType === 'checkpoint' ? `${modelsRoot}/checkpoints/${filename}` :
    modelType === 'lora'       ? `${modelsRoot}/loras/${filename}` :
                                 `${modelsRoot}/embeddings/${filename}`;

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
    // rm -f returns 0 even if the file is already gone — idempotent for both orphan-file and orphan-row cases
    const result = await ssh.execCommand(`rm -f "${remotePath}"`);
    if (result.code !== 0) {
      return NextResponse.json(
        { error: `Remote file deletion failed: ${result.stderr || 'rm exited non-zero'}` },
        { status: 500 },
      );
    }
  } catch (err) {
    return NextResponse.json({ error: `SSH error: ${String(err)}` }, { status: 500 });
  } finally {
    ssh.dispose();
  }

  try {
    if (modelType === 'checkpoint') {
      await prisma.checkpointConfig.deleteMany({ where: { checkpointName: filename } });
    } else if (modelType === 'lora') {
      await prisma.loraConfig.deleteMany({ where: { loraName: filename } });
    } else {
      await prisma.embeddingConfig.deleteMany({ where: { embeddingName: filename } });
    }
  } catch (err) {
    console.error('[models/delete] DB deleteMany failed:', err);
    return NextResponse.json({ error: `DB delete failed: ${String(err)}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
