'use client';

import { useState, useCallback } from 'react';

type ServiceName = 'comfy-illustrator' | 'aphrodite-architect' | 'aphrodite-janitor' | 'aphrodite-writer';
type ActionState = 'idle' | 'pending' | 'sent' | 'error';
type ServiceStatus = 'active' | 'inactive' | 'unknown';

const SERVICE_LABELS: Record<ServiceName, string> = {
  'comfy-illustrator': 'ComfyUI Illustrator',
  'aphrodite-architect': 'Aphrodite Architect',
  'aphrodite-janitor': 'Aphrodite Janitor',
  'aphrodite-writer': 'Aphrodite Writer',
};

const SERVICE_GROUPS: { label: string; description: string; services: ServiceName[] }[] = [
  {
    label: 'Illustrator Stack',
    description: 'ComfyUI image generation + writer LLM. These two always run together.',
    services: ['comfy-illustrator', 'aphrodite-writer'],
  },
  {
    label: 'Architect Stack',
    description: 'Architect + Janitor LLMs. These two always run together.',
    services: ['aphrodite-architect', 'aphrodite-janitor'],
  },
];

const BLANK_ACTIONS: Record<ServiceName, ActionState> = {
  'comfy-illustrator': 'idle',
  'aphrodite-architect': 'idle',
  'aphrodite-janitor': 'idle',
  'aphrodite-writer': 'idle',
};

const BLANK_STATUSES: Record<ServiceName, ServiceStatus> = {
  'comfy-illustrator': 'unknown',
  'aphrodite-architect': 'unknown',
  'aphrodite-janitor': 'unknown',
  'aphrodite-writer': 'unknown',
};

export default function ServerBay() {
  const [actionStates, setActionStates] = useState<Record<ServiceName, ActionState>>({ ...BLANK_ACTIONS });
  const [statusMap, setStatusMap] = useState<Record<ServiceName, ServiceStatus>>({ ...BLANK_STATUSES });
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setCheckingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/services/status');
      const data = await res.json() as { statuses?: Record<ServiceName, ServiceStatus>; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatusMap(data.statuses!);
    } catch (err) {
      setStatusError(String(err));
    } finally {
      setCheckingStatus(false);
    }
  }, []);

  const sendControl = useCallback(async (serviceName: ServiceName, action: 'start' | 'stop') => {
    setActionStates((prev) => ({ ...prev, [serviceName]: 'pending' }));
    try {
      const res = await fetch('/api/services/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName, action }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      setActionStates((prev) => ({
        ...prev,
        [serviceName]: data.ok ? 'sent' : 'error',
      }));
      // Re-check status after allowing time for the service to change state
      setTimeout(() => { void checkStatus(); }, 2500);
    } catch {
      setActionStates((prev) => ({ ...prev, [serviceName]: 'error' }));
    }
  }, [checkStatus]);

  return (
    <div className="p-4 space-y-4">
      {/* Header card */}
      <div className="card space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-200">Server Bay</h2>
          <button
            type="button"
            onClick={() => void checkStatus()}
            disabled={checkingStatus}
            className="min-h-12 px-3 flex items-center gap-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40 text-sm"
          >
            <svg
              className={`w-4 h-4 ${checkingStatus ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {checkingStatus ? 'Checking…' : 'Check Status'}
          </button>
        </div>
        <p className="text-xs text-zinc-400">
          Control remote VM services via SSH. Stacks are mutually exclusive — only one runs at a time.
        </p>
        {statusError && (
          <p className="text-xs text-red-400 pt-1">Status check failed: {statusError}</p>
        )}
      </div>

      {/* Service groups */}
      {SERVICE_GROUPS.map((group) => (
        <div key={group.label} className="card space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">{group.label}</h3>
            <p className="text-xs text-zinc-400 mt-0.5">{group.description}</p>
          </div>
          <div className="space-y-2 divide-y divide-zinc-800">
            {group.services.map((name) => (
              <ServiceRow
                key={name}
                label={SERVICE_LABELS[name]}
                status={statusMap[name]}
                actionState={actionStates[name]}
                onStart={() => void sendControl(name, 'start')}
                onStop={() => void sendControl(name, 'stop')}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Service row ───────────────────────────────────────────────────────────────

function ServiceRow({
  label,
  status,
  actionState,
  onStart,
  onStop,
}: {
  label: string;
  status: ServiceStatus;
  actionState: ActionState;
  onStart: () => void;
  onStop: () => void;
}) {
  const busy = actionState === 'pending';

  return (
    <div className="flex items-center gap-3 pt-2 first:pt-0">
      <StatusDot status={status} />
      <span className="flex-1 text-sm text-zinc-200 truncate">{label}</span>
      {actionState === 'sent' && (
        <span className="text-xs text-emerald-400 font-medium">Sent</span>
      )}
      {actionState === 'error' && (
        <span className="text-xs text-red-400 font-medium">Error</span>
      )}
      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="min-h-12 min-w-[5rem] px-3 rounded-lg text-sm font-medium
                   bg-emerald-700/20 hover:bg-emerald-700/40 text-emerald-300
                   border border-emerald-700/40 hover:border-emerald-600/60
                   transition-colors disabled:opacity-40"
      >
        {busy ? '…' : 'Start'}
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={busy}
        className="min-h-12 min-w-[5rem] px-3 rounded-lg text-sm font-medium
                   bg-red-700/20 hover:bg-red-700/40 text-red-300
                   border border-red-700/40 hover:border-red-600/60
                   transition-colors disabled:opacity-40"
      >
        {busy ? '…' : 'Stop'}
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: ServiceStatus }) {
  const color =
    status === 'active'
      ? 'bg-emerald-400'
      : status === 'inactive'
      ? 'bg-red-500'
      : 'bg-zinc-600';
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} />;
}
