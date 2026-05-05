import { NodeSSH } from 'node-ssh';
import { loadServicesConfig, type ServiceConfig } from '@/lib/servicesConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VM_USER = process.env.GPU_VM_USER ?? '';
const VM_IP = process.env.GPU_VM_IP ?? '';
const SSH_KEY_PATH = process.env.GPU_VM_SSH_KEY_PATH ?? '';

type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runSystemctlChecks(
  ssh: NodeSSH,
  services: ServiceConfig[],
): Promise<Record<string, number>> {
  const cmd = services
    .map((s) => `systemctl is-active ${s.unit} >/dev/null 2>&1; echo "${s.key}:$?"`)
    .join('; ');

  const result = await ssh.execCommand(cmd);

  const exitCodes: Record<string, number> = {};
  for (const s of services) {
    exitCodes[s.key] = 1; // default: not active
  }

  for (const line of result.stdout.split('\n')) {
    for (const s of services) {
      if (line.startsWith(`${s.key}:`)) {
        const code = parseInt(line.slice(s.key.length + 1).trim(), 10);
        exitCodes[s.key] = isNaN(code) ? 1 : code;
      }
    }
  }

  return exitCodes;
}

export async function GET() {
  if (!SSH_KEY_PATH) {
    return Response.json({ error: 'GPU_VM_SSH_KEY_PATH not configured' }, { status: 500 });
  }
  if (!VM_USER) {
    return Response.json({ error: 'GPU_VM_USER not configured' }, { status: 500 });
  }
  if (!VM_IP) {
    return Response.json({ error: 'GPU_VM_IP not configured' }, { status: 500 });
  }

  const services = loadServicesConfig();
  if (services.length === 0) {
    return Response.json({ statuses: {} });
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });

    const [systemdResults, probeResults] = await Promise.all([
      runSystemctlChecks(ssh, services),
      Promise.all(services.map((s) => probe(s.probeUrl))),
    ]);

    const statuses: Record<string, ServiceStatus> = {};
    services.forEach((s, i) => {
      const systemdActive = systemdResults[s.key] === 0;
      const probeOk = probeResults[i];
      if (!systemdActive) statuses[s.key] = 'inactive';
      else if (probeOk) statuses[s.key] = 'ready';
      else statuses[s.key] = 'loading';
    });

    return Response.json({ statuses });
  } catch (err) {
    return Response.json({ error: `SSH error: ${String(err)}` }, { status: 500 });
  } finally {
    ssh.dispose();
  }
}
