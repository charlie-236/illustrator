import { NodeSSH } from 'node-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VM_USER = process.env.GPU_VM_USER ?? '';
const VM_IP = process.env.GPU_VM_IP ?? '';
const SSH_KEY_PATH = process.env.GPU_VM_SSH_KEY_PATH ?? '';

type ServiceName = 'comfy-illustrator' | 'aphrodite-writer' | 'aphrodite-cinematographer';
type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';

const SERVICE_CONFIG: Record<ServiceName, { unit: string; probeUrl: string }> = {
  'comfy-illustrator': {
    unit: 'comfy-illustrator.service',
    probeUrl: 'http://127.0.0.1:8188/system_stats',
  },
  'aphrodite-writer': {
    unit: 'aphrodite-writer',
    probeUrl: 'http://127.0.0.1:21434/health',
  },
  'aphrodite-cinematographer': {
    unit: 'aphrodite-cinematographer',
    probeUrl: 'http://127.0.0.1:11438/health',
  },
};

const SERVICES: ServiceName[] = [
  'comfy-illustrator',
  'aphrodite-writer',
  'aphrodite-cinematographer',
];

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runSystemctlChecks(ssh: NodeSSH): Promise<Record<ServiceName, number>> {
  const cmd = SERVICES
    .map((name) => `systemctl is-active ${SERVICE_CONFIG[name].unit} >/dev/null 2>&1; echo "${name}:$?"`)
    .join('; ');

  const result = await ssh.execCommand(cmd);

  const exitCodes: Record<ServiceName, number> = {
    'comfy-illustrator': 1,
    'aphrodite-writer': 1,
    'aphrodite-cinematographer': 1,
  };

  for (const line of result.stdout.split('\n')) {
    for (const name of SERVICES) {
      if (line.startsWith(`${name}:`)) {
        const code = parseInt(line.slice(name.length + 1).trim(), 10);
        exitCodes[name] = isNaN(code) ? 1 : code;
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

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VM_IP, username: VM_USER, privateKeyPath: SSH_KEY_PATH });

    const [systemdResults, probeResults] = await Promise.all([
      runSystemctlChecks(ssh),
      Promise.all(SERVICES.map((s) => probe(SERVICE_CONFIG[s].probeUrl))),
    ]);

    const statuses: Record<ServiceName, ServiceStatus> = {
      'comfy-illustrator': 'unknown',
      'aphrodite-writer': 'unknown',
      'aphrodite-cinematographer': 'unknown',
    };

    SERVICES.forEach((name, i) => {
      const systemdActive = systemdResults[name] === 0;
      const probeOk = probeResults[i];
      if (!systemdActive) statuses[name] = 'inactive';
      else if (probeOk) statuses[name] = 'ready';
      else statuses[name] = 'loading';
    });

    return Response.json({ statuses });
  } catch (err) {
    return Response.json({ error: `SSH error: ${String(err)}` }, { status: 500 });
  } finally {
    ssh.dispose();
  }
}
