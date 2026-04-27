'use client';

import { useState, useCallback } from 'react';

type ServiceName = 'comfy-illustrator' | 'aphrodite-writer' | 'aphrodite-illustrator-polisher';
type ActionState = 'idle' | 'pending' | 'sent' | 'error';
type ServiceStatus = 'active' | 'inactive' | 'unknown';

const SERVICE_LABELS: Record<ServiceName, string> = {
  'comfy-illustrator': 'ComfyUI Illustrator',
  'aphrodite-writer': 'Aphrodite Writer',
  'aphrodite-illustrator-polisher': 'Aphrodite Illustrator Polisher',
};

const ALL_SERVICES: ServiceName[] = [
  'comfy-illustrator',
  'aphrodite-writer',
  'aphrodite-illustrator-polisher',
];

const STACK_ORDER_START: ServiceName[] = [
  'comfy-illustrator',
  'aphrodite-writer',
  'aphrodite-illustrator-polisher',
];
const STACK_ORDER_STOP: ServiceName[] = [
  'aphrodite-illustrator-polisher',
  'aphrodite-writer',
  'comfy-illustrator',
];

type StackProgressEntry = {
  service: ServiceName;
  status: 'pending' | 'running' | 'ok' | 'error';
  error?: string;
};

type StackOp = {
  action: 'start' | 'stop' | null;
  progress: StackProgressEntry[];
};

const BLANK_ACTIONS: Record<ServiceName, ActionState> = {
  'comfy-illustrator': 'idle',
  'aphrodite-writer': 'idle',
  'aphrodite-illustrator-polisher': 'idle',
};

const BLANK_STATUSES: Record<ServiceName, ServiceStatus> = {
  'comfy-illustrator': 'unknown',
  'aphrodite-writer': 'unknown',
  'aphrodite-illustrator-polisher': 'unknown',
};

export default function ServerBay() {
  const [actionStates, setActionStates] = useState<Record<ServiceName, ActionState>>({ ...BLANK_ACTIONS });
  const [statusMap, setStatusMap] = useState<Record<ServiceName, ServiceStatus>>({ ...BLANK_STATUSES });
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stackOp, setStackOp] = useState<StackOp | null>(null);

  const stackBusy = stackOp !== null && stackOp.action !== null;

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
      setTimeout(() => { void checkStatus(); }, 2500);
    } catch {
      setActionStates((prev) => ({ ...prev, [serviceName]: 'error' }));
    }
  }, [checkStatus]);

  const runStackSequence = useCallback(async (action: 'start' | 'stop') => {
    const order = action === 'start' ? STACK_ORDER_START : STACK_ORDER_STOP;
    setStackOp({
      action,
      progress: order.map((service) => ({ service, status: 'pending' })),
    });

    for (let i = 0; i < order.length; i++) {
      const svc = order[i];
      setStackOp((prev) => prev ? {
        ...prev,
        progress: prev.progress.map((p, idx) => idx === i ? { ...p, status: 'running' } : p),
      } : prev);

      try {
        const res = await fetch('/api/services/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceName: svc, action }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (!data.ok) {
          const errMsg = data.error ?? `HTTP ${res.status}`;
          setStackOp((prev) => prev ? {
            ...prev,
            progress: prev.progress.map((p, idx) => idx === i ? { ...p, status: 'error', error: errMsg } : p),
          } : prev);
          break;
        }
        setStackOp((prev) => prev ? {
          ...prev,
          progress: prev.progress.map((p, idx) => idx === i ? { ...p, status: 'ok' } : p),
        } : prev);
      } catch (err) {
        setStackOp((prev) => prev ? {
          ...prev,
          progress: prev.progress.map((p, idx) => idx === i ? { ...p, status: 'error', error: String(err) } : p),
        } : prev);
        break;
      }
    }

    setStackOp((prev) => prev ? { ...prev, action: null } : prev);
    setTimeout(() => { void checkStatus(); }, 2500);
  }, [checkStatus]);

  return (
    <div className="p-4 space-y-4">
      {/* Illustrator Stack card */}
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Illustrator Stack</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            ComfyUI + Writer LLM + Prompt Polisher. Start and stop as a group, or control individually below.
          </p>
        </div>

        {/* Stack-level controls */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void runStackSequence('start')}
            disabled={stackBusy}
            className="flex-1 min-h-12 rounded-lg text-sm font-medium
                       bg-emerald-700/20 hover:bg-emerald-700/40 text-emerald-300
                       border border-emerald-700/40 hover:border-emerald-600/60
                       transition-colors disabled:opacity-40"
          >
            Start All
          </button>
          <button
            type="button"
            onClick={() => void runStackSequence('stop')}
            disabled={stackBusy}
            className="flex-1 min-h-12 rounded-lg text-sm font-medium
                       bg-red-700/20 hover:bg-red-700/40 text-red-300
                       border border-red-700/40 hover:border-red-600/60
                       transition-colors disabled:opacity-40"
          >
            Stop All
          </button>
        </div>

        {/* Stack operation progress */}
        {stackOp && (
          <div className="space-y-1.5 pt-0.5">
            {stackOp.progress.map((entry) => (
              <div key={entry.service} className="flex items-start gap-2 text-sm">
                <StackProgressIcon status={entry.status} />
                <div className="flex-1 min-w-0">
                  <span className={entry.status === 'error' ? 'text-red-300' : 'text-zinc-300'}>
                    {SERVICE_LABELS[entry.service]}
                  </span>
                  {entry.error && (
                    <p className="text-xs text-red-400 mt-0.5 break-words">{entry.error}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-zinc-800" />

        {/* Individual service rows */}
        <div className="space-y-2 divide-y divide-zinc-800">
          {ALL_SERVICES.map((name) => (
            <ServiceRow
              key={name}
              label={SERVICE_LABELS[name]}
              status={statusMap[name]}
              actionState={actionStates[name]}
              disabled={stackBusy}
              onStart={() => void sendControl(name, 'start')}
              onStop={() => void sendControl(name, 'stop')}
            />
          ))}
        </div>
      </div>

      {/* Status check card */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-300">Service Status</p>
            {statusError && (
              <p className="text-xs text-red-400 mt-0.5">Check failed: {statusError}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void checkStatus()}
            disabled={checkingStatus}
            className="min-h-12 px-4 flex items-center gap-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40 text-sm"
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
      </div>
    </div>
  );
}

// ── Stack progress icon ───────────────────────────────────────────────────────

function StackProgressIcon({ status }: { status: StackProgressEntry['status'] }) {
  if (status === 'running') {
    return (
      <svg className="w-4 h-4 animate-spin flex-shrink-0 mt-0.5 text-violet-400" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
    );
  }
  if (status === 'ok') {
    return (
      <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <span className="w-4 h-4 flex-shrink-0 mt-0.5 flex items-center justify-center">
      <span className="w-2 h-2 rounded-full bg-zinc-600" />
    </span>
  );
}

// ── Service row ───────────────────────────────────────────────────────────────

function ServiceRow({
  label,
  status,
  actionState,
  disabled,
  onStart,
  onStop,
}: {
  label: string;
  status: ServiceStatus;
  actionState: ActionState;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const rowBusy = actionState === 'pending' || disabled;

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
        disabled={rowBusy}
        className="min-h-12 min-w-[5rem] px-3 rounded-lg text-sm font-medium
                   bg-emerald-700/20 hover:bg-emerald-700/40 text-emerald-300
                   border border-emerald-700/40 hover:border-emerald-600/60
                   transition-colors disabled:opacity-40"
      >
        {actionState === 'pending' ? '…' : 'Start'}
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={rowBusy}
        className="min-h-12 min-w-[5rem] px-3 rounded-lg text-sm font-medium
                   bg-red-700/20 hover:bg-red-700/40 text-red-300
                   border border-red-700/40 hover:border-red-600/60
                   transition-colors disabled:opacity-40"
      >
        {actionState === 'pending' ? '…' : 'Stop'}
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
