'use client';

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { playChime, requestNotificationPermission, sendBrowserNotification } from '@/lib/notification';
import type { ActiveQueueJobInfo } from '@/types';

// ─── types ────────────────────────────────────────────────────────────────────

export interface ActiveJob {
  /** Stable primary key — set immediately on submit, before ComfyUI accepts the job. */
  queuedJobId: string;
  /** Set once the runner submits to ComfyUI; null while pending in our DB queue. */
  promptId: string | null;
  generationId: string;
  mediaType: 'image' | 'video' | 'stitch';
  promptSummary: string;
  /** Unix ms when the job was added to the client queue. */
  startedAt: number;
  /** Unix ms when ComfyUI began executing. Null while pending or queued at ComfyUI. */
  runningSince: number | null;
  /** Unix ms when the job entered a terminal state. Used to freeze elapsed display. */
  terminalAt?: number;
  progress: { current: number; total: number } | null;
  status: 'pending' | 'queued' | 'running' | 'completing' | 'done' | 'error';
  errorMessage?: string;
  /** 1-indexed position in the pending DB queue; null if not pending. */
  queuePosition: number | null;
  retryCount: number;
  lastFailReason: string | null;
}

export interface ToastEntry {
  id: string;
  mediaType: 'image' | 'video' | 'stitch';
  promptSummary: string;
  generationId: string;
}

interface QueueState {
  jobs: ActiveJob[];
  muted: boolean;
  toasts: ToastEntry[];
}

type QueueAction =
  | { type: 'UPSERT_JOB'; job: ActiveJob }
  | { type: 'REMOVE_JOB'; queuedJobId: string }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'DISMISS_TOAST'; id: string };

// ─── reducer ─────────────────────────────────────────────────────────────────

function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'UPSERT_JOB': {
      const idx = state.jobs.findIndex((j) => j.queuedJobId === action.job.queuedJobId);
      if (idx === -1) {
        // New job — prepend
        return { ...state, jobs: [action.job, ...state.jobs] };
      }
      const existing = state.jobs[idx];

      // Detect done transition before narrowing — TS2367 fires if we check after the terminal guard
      const isDoneTransition = action.job.status === 'done' && existing.status !== 'done' && existing.status !== 'error';

      // Never downgrade terminal state
      if (existing.status === 'done' || existing.status === 'error') return state;

      const jobs = [...state.jobs];
      jobs[idx] = { ...existing, ...action.job };

      if (isDoneTransition) {
        const toast: ToastEntry = {
          id: `${action.job.queuedJobId}-${Date.now()}`,
          mediaType: action.job.mediaType,
          promptSummary: action.job.promptSummary,
          generationId: action.job.generationId,
        };
        return { ...state, jobs, toasts: [...state.toasts, toast] };
      }

      return { ...state, jobs };
    }

    case 'REMOVE_JOB': {
      return { ...state, jobs: state.jobs.filter((j) => j.queuedJobId !== action.queuedJobId) };
    }

    case 'TOGGLE_MUTE': {
      const muted = !state.muted;
      try { localStorage.setItem('queue-muted', muted ? '1' : '0'); } catch { /* ignore */ }
      return { ...state, muted };
    }

    case 'DISMISS_TOAST': {
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    }

    default:
      return state;
  }
}

// ─── context ─────────────────────────────────────────────────────────────────

interface QueueContextValue {
  jobs: ActiveJob[];
  muted: boolean;
  toasts: ToastEntry[];
  /** Add a job immediately on submit (status='pending'). */
  addJob: (job: ActiveJob) => void;
  removeJob: (queuedJobId: string) => void;
  toggleMute: () => void;
  dismissToast: (id: string) => void;
  requestPermissionIfNeeded: () => void;
}

const QueueContext = createContext<QueueContextValue | null>(null);

// ─── provider ─────────────────────────────────────────────────────────────────

function getInitialMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem('queue-muted') === '1'; } catch { return false; }
}

function serverJobToActiveJob(sj: ActiveQueueJobInfo, existingStartedAt?: number): ActiveJob {
  return {
    queuedJobId: sj.queuedJobId,
    promptId: sj.promptId,
    generationId: sj.generationId,
    mediaType: sj.mediaType,
    promptSummary: sj.promptSummary,
    startedAt: existingStartedAt ?? Date.now(),
    runningSince: sj.runningSince ? new Date(sj.runningSince).getTime() : null,
    progress: sj.progress,
    status: mapStatus(sj.status),
    queuePosition: sj.queuePosition,
    retryCount: sj.retryCount,
    lastFailReason: sj.lastFailReason,
  };
}

type ServerStatus = ActiveQueueJobInfo['status'];
function mapStatus(s: ServerStatus): ActiveJob['status'] {
  switch (s) {
    case 'pending': return 'pending';
    case 'submitted': return 'queued';
    case 'running': return 'running';
    case 'completing': return 'completing';
    case 'complete': return 'done';
    case 'failed': return 'error';
    case 'cancelled': return 'error';
    default: return 'pending';
  }
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    jobs: [] as ActiveJob[],
    muted: getInitialMuted(),
    toasts: [] as ToastEntry[],
  }));

  // ── notification side effects ──────────────────────────────────────────────
  const prevJobsRef = useRef(new Map<string, ActiveJob>());

  useEffect(() => {
    const prev = prevJobsRef.current;

    for (const job of state.jobs) {
      const prevJob = prev.get(job.queuedJobId);
      if (job.status === 'done' && prevJob && prevJob.status !== 'done') {
        if (!state.muted) playChime();
        sendBrowserNotification({
          title: 'Generation complete',
          body: job.promptSummary || (
            job.mediaType === 'stitch' ? 'Project stitch' :
            job.mediaType === 'video' ? 'Video generation' : 'Image generation'
          ),
          tag: job.queuedJobId,
        });
      }
    }

    prevJobsRef.current = new Map(state.jobs.map((j) => [j.queuedJobId, j]));
  }, [state.jobs, state.muted]);

  // ── auto-dismiss completed/errored jobs after 60 s ────────────────────────
  const autoDismissRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return () => {
      for (const timer of autoDismissRef.current.values()) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    for (const job of state.jobs) {
      if ((job.status === 'done' || job.status === 'error') && !autoDismissRef.current.has(job.queuedJobId)) {
        const timer = setTimeout(() => {
          dispatch({ type: 'REMOVE_JOB', queuedJobId: job.queuedJobId });
          autoDismissRef.current.delete(job.queuedJobId);
        }, 60_000);
        autoDismissRef.current.set(job.queuedJobId, timer);
      }
    }

    for (const [queuedJobId, timer] of autoDismissRef.current) {
      if (!state.jobs.some((j) => j.queuedJobId === queuedJobId)) {
        clearTimeout(timer);
        autoDismissRef.current.delete(queuedJobId);
      }
    }
  }, [state.jobs]);

  // ── poll /api/queue/active ────────────────────────────────────────────────
  // Poll while any jobs are non-terminal (pending/queued/running/completing)
  const hasActiveJobs = state.jobs.some(
    (j) => j.status === 'pending' || j.status === 'queued' || j.status === 'running' || j.status === 'completing',
  );

  // Snapshot jobs map so the poll callback can read current startedAt without re-subscribing
  const jobsMapRef = useRef(new Map<string, ActiveJob>());
  jobsMapRef.current = new Map(state.jobs.map((j) => [j.queuedJobId, j]));

  useEffect(() => {
    // Always poll when we have any tracked jobs (active or recently terminal) so
    // we can sync completed status from server without missing transitions
    const shouldPoll = state.jobs.length > 0;
    if (!shouldPoll) return;

    const poll = async () => {
      try {
        const res = await fetch('/api/queue/active');
        if (!res.ok) return;
        const { jobs: serverJobs } = await res.json() as { jobs: ActiveQueueJobInfo[] };

        for (const sj of serverJobs) {
          const existing = jobsMapRef.current.get(sj.queuedJobId);
          // Only update jobs the client is already tracking (prevents phantom jobs appearing after dismiss)
          if (!existing) continue;
          dispatch({
            type: 'UPSERT_JOB',
            job: serverJobToActiveJob(sj, existing.startedAt),
          });
        }
      } catch { /* ignore poll errors */ }
    };

    const pollInterval = Number(process.env.NEXT_PUBLIC_QUEUE_POLL_INTERVAL_MS) || 5_000;
    const interval = setInterval(poll, pollInterval);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveJobs, state.jobs.length]);

  // ── permission request ─────────────────────────────────────────────────────
  const permRequestedRef = useRef(false);
  const requestPermissionIfNeeded = useCallback(() => {
    if (permRequestedRef.current) return;
    permRequestedRef.current = true;
    void requestNotificationPermission();
  }, []);

  // ── stable action creators ─────────────────────────────────────────────────
  const addJob = useCallback((job: ActiveJob) => dispatch({ type: 'UPSERT_JOB', job }), []);
  const removeJob = useCallback((queuedJobId: string) => dispatch({ type: 'REMOVE_JOB', queuedJobId }), []);
  const toggleMute = useCallback(() => dispatch({ type: 'TOGGLE_MUTE' }), []);
  const dismissToast = useCallback((id: string) => dispatch({ type: 'DISMISS_TOAST', id }), []);

  return (
    <QueueContext.Provider value={{
      jobs: state.jobs,
      muted: state.muted,
      toasts: state.toasts,
      addJob,
      removeJob,
      toggleMute,
      dismissToast,
      requestPermissionIfNeeded,
    }}>
      {children}
    </QueueContext.Provider>
  );
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue must be used within QueueProvider');
  return ctx;
}
