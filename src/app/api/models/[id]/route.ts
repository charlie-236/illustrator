import { NextRequest, NextResponse } from 'next/server';
import { NodeSSH } from 'node-ssh';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Credentials from env — never hardcoded, never contact VM IP directly
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!SSH_KEY_PATH) {
    return NextResponse.json({ error: 'A100_SSH_KEY_PATH not configured' }, { status: 500 });
  }
  if (!VM_USER) {
    return NextResponse.json({ error: 'A100_VM_USER not configured' }, { status: 500 });
  }
  if (!VM_IP) {
    return NextResponse.json({ error: 'A100_VM_IP not configured' }, { status: 500 });
  }

  // Step 1: Locate the record — check checkpoints first, then LoRAs
  let modelType: 'checkpoint' | 'lora';
  let filename: string;

  const ckpt = await prisma.checkpointConfig.findUnique({ where: { id } });
  if (ckpt) {
    modelType = 'checkpoint';
    filename = ckpt.checkpointName;
  } else {
    const lora = await prisma.loraConfig.findUnique({ where: { id } });
    if (!lora) return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    modelType = 'lora';
    filename = lora.loraName;
  }

  // Step 2: Delete the file from the VM via SSH
  // VM_IP is read from process.env (A100_VM_IP) — never hardcoded in source
  const remotePath = modelType === 'lora'
    ? `/models/ComfyUI/models/loras/${filename}`
    : `/models/ComfyUI/models/checkpoints/${filename}`;

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
    // rm -f returns 0 even if the file is already gone, so this is idempotent
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

  // Step 3: Purge the DB record now that the file is confirmed gone
  try {
    if (modelType === 'checkpoint') {
      await prisma.checkpointConfig.delete({ where: { id } });
    } else {
      await prisma.loraConfig.delete({ where: { id } });
    }
  } catch (err) {
    return NextResponse.json({ error: `DB delete failed: ${String(err)}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
