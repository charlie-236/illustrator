'use client';

import { useState, useCallback, useEffect } from 'react';

interface ServiceMeta {
  key: string;
  label: string;
}

type ActionState = 'idle' | 'pending' | 'sent' | 'error';
type ServiceStatus = 'ready' | 'loading' | 'inactive' | 'unknown';

type StackProgressEntry = {
  service: string;
  status: 'pending' | 'running' | 'ok' | 'error';
  error?: string;
};

type StackOp = {
  action: 'start' | 'stop' | null;
  progress: StackProgressEntry[];
};

export default function ServerBay() {
  const [services, setServices] = useState<ServiceMeta[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);

  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});
  const [statusMap, setStatusMap] = useState<Record<string, ServiceStatus>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stackOp, setStackOp] = useState<StackOp | null>(null);

  const stackBusy = stackOp !== null && stackOp.action !== null;

  // Load services list on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/services/list');
        const data = await res.json() as { services: ServiceMeta[] };
        if (cancelled) return;
        setServices(data.services);
        const initActions: Record<string, ActionState> = {};
        const initStatuses: Record<string, ServiceStatus> = {};
        for (const s of data.services) {
          initActions[s.key] = 'idle';
          initStatuses[s.key] = 'unknown';
        }
        setActionStates(initActions);
        setStatusMap(initStatuses);
      } catch (err) {
        if (!cancelled) setServicesError(String(err));
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const checkStatus = useCallback(async () => {
    setCheckingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/services/status');
      const data = await res.json() as { statuses?: Record<string, ServiceStatus>; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatusMap(data.statuses!);
    } catch (err) {
      setStatusError(String(err));
    } finally {
      setCheckingStatus(false);
    }
  }, []);

  const sendControl = useCallback(async (serviceKey: string, action: 'start' | 'stop') => {
    setActionStates((prev) => ({ ...prev, [serviceKey]: 'pending' }));
    try {
      const res = await fetch('/api/services/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName: serviceKey, action }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      setActionStates((prev) => ({
        ...prev,
        [serviceKey]: data.ok ? 'sent' : 'error',
      }));
      setTimeout(() => { void checkStatus(); }, 2500);
    } catch {
      setActionStates((prev) => ({ ...prev, [serviceKey]: 'error' }));
    }
  }, [checkStatus]);

  const runStackSequence = useCallback(async (action: 'start' | 'stop') => {
    const order = action === 'start' ? services : [...services].reverse();
    setStackOp({
      action,
      progress: order.map((s) => ({ service: s.key, status: 'pending' })),
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
          body: JSON.stringify({ serviceName: svc.key, action }),
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
  }, [services, checkStatus]);

  const serviceLabel = useCallback((key: string): string => {
    return services.find((s) => s.key === key)?.label ?? key;
  }, [services]);

  return (
    <div className="p-4 space-y-4">
      {/* Loom Stack card */}
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Loom Stack</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Start and stop all configured services as a group, or control individually below.
          </p>
        </div>

        {servicesLoading ? (
          <p className="text-sm text-zinc-500">Loading services…</p>
        ) : servicesError ? (
          <p className="text-sm text-red-400">Failed to load services: {servicesError}</p>
        ) : services.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-700 p-6 text-center">
            <p className="text-sm text-zinc-400">No services configured.</p>
            <p className="text-xs text-zinc-500 mt-2">
              Add SERVICE_1_KEY (and the other SERVICE_1_* vars) to your .env file
              to populate this panel.
            </p>
          </div>
        ) : (
          <>
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
                      <span className={`truncate block ${entry.status === 'error' ? 'text-red-300' : 'text-zinc-300'}`}>
                        {serviceLabel(entry.service)}
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
              {services.map((svc) => (
                <ServiceRow
                  key={svc.key}
                  label={svc.label}
                  status={statusMap[svc.key] ?? 'unknown'}
                  actionState={actionStates[svc.key] ?? 'idle'}
                  disabled={stackBusy}
                  onStart={() => void sendControl(svc.key, 'start')}
                  onStop={() => void sendControl(svc.key, 'stop')}
                />
              ))}
            </div>
          </>
        )}
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
    status === 'ready'
      ? 'bg-emerald-400'
      : status === 'loading'
      ? 'bg-amber-400 animate-pulse'
      : status === 'inactive'
      ? 'bg-red-500'
      : 'bg-zinc-600';
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} />;
}
