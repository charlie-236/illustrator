import { NodeSSH } from 'node-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

type ServiceName = 'comfy-illustrator' | 'aphrodite-writer' | 'aphrodite-illustrator-polisher';
type ServiceStatus = 'active' | 'inactive' | 'unknown';

const SERVICE_UNITS: Record<ServiceName, string> = {
  'comfy-illustrator': 'comfy-illustrator.service',
  'aphrodite-writer': 'aphrodite-writer',
  'aphrodite-illustrator-polisher': 'aphrodite-illustrator-polisher',
};

const SERVICES: ServiceName[] = [
  'comfy-illustrator',
  'aphrodite-writer',
  'aphrodite-illustrator-polisher',
];

export async function GET() {
  if (!SSH_KEY_PATH) {
    return Response.json({ error: 'A100_SSH_KEY_PATH not configured' }, { status: 500 });
  }
  if (!VM_USER) {
    return Response.json({ error: 'A100_VM_USER not configured' }, { status: 500 });
  }
  if (!VM_IP) {
    return Response.json({ error: 'A100_VM_IP not configured' }, { status: 500 });
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });

    // Run all checks in a single SSH round-trip; each line emits "name:exitcode"
    const cmd = SERVICES
      .map((name) => `systemctl is-active ${SERVICE_UNITS[name]} >/dev/null 2>&1; echo "${name}:$?"`)
      .join('; ');

    const result = await ssh.execCommand(cmd);

    const statuses: Record<ServiceName, ServiceStatus> = {
      'comfy-illustrator': 'unknown',
      'aphrodite-writer': 'unknown',
      'aphrodite-illustrator-polisher': 'unknown',
    };

    for (const line of result.stdout.split('\n')) {
      for (const name of SERVICES) {
        if (line.startsWith(`${name}:`)) {
          const code = line.slice(name.length + 1).trim();
          statuses[name] = code === '0' ? 'active' : 'inactive';
        }
      }
    }

    return Response.json({ statuses });
  } catch (err) {
    return Response.json({ error: `SSH error: ${String(err)}` }, { status: 500 });
  } finally {
    ssh.dispose();
  }
}
