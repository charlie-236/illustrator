import { NextRequest } from 'next/server';
import { NodeSSH } from 'node-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

// Exact systemctl unit names per service key
const SERVICE_UNITS: Record<string, string> = {
  'comfy-illustrator': 'comfy-illustrator.service',
  'aphrodite-writer': 'aphrodite-writer',
  'aphrodite-illustrator-polisher': 'aphrodite-illustrator-polisher',
};

export async function POST(req: NextRequest) {
  if (!SSH_KEY_PATH) {
    return Response.json({ error: 'A100_SSH_KEY_PATH not configured' }, { status: 500 });
  }
  if (!VM_USER) {
    return Response.json({ error: 'A100_VM_USER not configured' }, { status: 500 });
  }
  if (!VM_IP) {
    return Response.json({ error: 'A100_VM_IP not configured' }, { status: 500 });
  }

  let body: { serviceName: string; action: string };
  try {
    body = await req.json() as { serviceName: string; action: string };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { serviceName, action } = body;

  const unit = SERVICE_UNITS[serviceName];
  if (!unit) {
    return Response.json({ error: `Unknown service: ${serviceName}` }, { status: 400 });
  }
  if (action !== 'start' && action !== 'stop') {
    return Response.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });
    const result = await ssh.execCommand(`sudo systemctl ${action} ${unit}`);
    if (result.code !== 0) {
      return Response.json({
        ok: false,
        error: result.stderr || `systemctl ${action} ${unit} exited ${result.code}`,
      });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: `SSH error: ${String(err)}` }, { status: 500 });
  } finally {
    ssh.dispose();
  }
}
