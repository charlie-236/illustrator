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
import type { ActiveJobInfo } from '@/lib/comfyws';

// ─── types ────────────────────────────────────────────────────────────────────

export interface ActiveJob {
  promptId: string;
  generationId: string;
  mediaType: 'image' | 'video' | 'stitch';
  promptSummary: string;
  startedAt: number;
  /** Unix ms when ComfyUI began executing this job. Null while in ComfyUI's queue. */
  runningSince: number | null;
  progress: { current: number; total: number } | null;
  status: 'queued' | 'running' | 'completing' | 'done' | 'error';
  errorMessage?: string;
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
  | { type: 'ADD_JOB'; job: ActiveJob }
  | { type: 'UPDATE_PROGRESS'; promptId: string; progress: { current: number; total: number } }
  | { type: 'TRANSITION_TO_RUNNING'; promptId: string; runningSince: number }
  | { type: 'SET_COMPLETING'; promptId: string }
  | { type: 'COMPLETE_JOB'; promptId: string; generationId: string }
  | { type: 'FAIL_JOB'; promptId: string; errorMessage: string }
  | { type: 'REMOVE_JOB'; promptId: string }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'DISMISS_TOAST'; id: string };

// ─── reducer ─────────────────────────────────────────────────────────────────

function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'ADD_JOB': {
      if (state.jobs.some((j) => j.promptId === action.job.promptId)) return state;
      return { ...state, jobs: [action.job, ...state.jobs] };
    }

    case 'UPDATE_PROGRESS': {
      return {
        ...state,
        jobs: state.jobs.map((j) => {
          if (j.promptId !== action.promptId) return j;
          // First progress event while queued → auto-transition to running
          if (j.status === 'queued') {
            return { ...j, status: 'running', runningSince: j.runningSince ?? Date.now(), progress: action.progress };
          }
          if (j.status === 'running') {
            return { ...j, progress: action.progress };
          }
          return j;
        }),
      };
    }

    case 'TRANSITION_TO_RUNNING': {
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId && j.status === 'queued'
            ? { ...j, status: 'running', runningSince: action.runningSince }
            : j,
        ),
      };
    }

    case 'SET_COMPLETING': {
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId &&
          (j.status === 'queued' || j.status === 'running' || j.status === 'completing')
            ? { ...j, status: 'completing', runningSince: j.runningSince ?? Date.now() }
            : j,
        ),
      };
    }

    case 'COMPLETE_JOB': {
      const job = state.jobs.find((j) => j.promptId === action.promptId);
      if (!job || job.status === 'done') return state;
      const toast: ToastEntry = {
        id: `${action.promptId}-${Date.now()}`,
        mediaType: job.mediaType,
        promptSummary: job.promptSummary,
        generationId: action.generationId,
      };
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId
            ? { ...j, status: 'done', generationId: action.generationId, progress: null }
            : j,
        ),
        toasts: [...state.toasts, toast],
      };
    }

    case 'FAIL_JOB': {
      if (!state.jobs.some((j) => j.promptId === action.promptId && j.status !== 'error')) {
        return state;
      }
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId
            ? { ...j, status: 'error', errorMessage: action.errorMessage }
            : j,
        ),
      };
    }

    case 'REMOVE_JOB': {
      return { ...state, jobs: state.jobs.filter((j) => j.promptId !== action.promptId) };
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
  addJob: (job: ActiveJob) => void;
  updateProgress: (promptId: string, progress: { current: number; total: number }) => void;
  setCompleting: (promptId: string) => void;
  completeJob: (promptId: string, generationId: string) => void;
  failJob: (promptId: string, errorMessage: string) => void;
  removeJob: (promptId: string) => void;
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

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    jobs: [] as ActiveJob[],
    muted: getInitialMuted(),
    toasts: [] as ToastEntry[],
  }));

  // ── notification side effects ──────────────────────────────────────────────
  // Track previous job statuses to detect transitions (not just new state)
  const prevJobsRef = useRef(new Map<string, ActiveJob>());

  useEffect(() => {
    const prev = prevJobsRef.current;

    for (const job of state.jobs) {
      const prevJob = prev.get(job.promptId);
      // Only notify for transitions observed within this session (prevJob existed as non-done)
      if (job.status === 'done' && prevJob && prevJob.status !== 'done') {
        if (!state.muted) playChime();
        sendBrowserNotification({
          title: 'Generation complete',
          body: job.promptSummary || (
            job.mediaType === 'stitch' ? 'Project stitch' :
            job.mediaType === 'video' ? 'Video generation' : 'Image generation'
          ),
          tag: job.promptId,
        });
      }
    }

    prevJobsRef.current = new Map(state.jobs.map((j) => [j.promptId, j]));
  }, [state.jobs, state.muted]);

  // ── auto-dismiss completed jobs after 30 s ─────────────────────────────────
  const autoDismissRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    // Schedule auto-dismiss for newly-done jobs
    for (const job of state.jobs) {
      if (job.status === 'done' && !autoDismissRef.current.has(job.promptId)) {
        const timer = setTimeout(() => {
          dispatch({ type: 'REMOVE_JOB', promptId: job.promptId });
          autoDismissRef.current.delete(job.promptId);
        }, 30_000);
        autoDismissRef.current.set(job.promptId, timer);
      }
    }

    // Cancel timers for jobs no longer in state (manually dismissed)
    for (const [promptId, timer] of autoDismissRef.current) {
      if (!state.jobs.some((j) => j.promptId === promptId)) {
        clearTimeout(timer);
        autoDismissRef.current.delete(promptId);
      }
    }

    return () => {
      for (const timer of autoDismissRef.current.values()) clearTimeout(timer);
    };
  }, [state.jobs]);

  // ── poll /api/jobs/active while any jobs are active (queued/running/completing)
  // This provides refresh-survivability: after a page reload the client reattaches
  // to in-flight jobs via the mount-recovery effect in Studio, and the polling
  // here keeps progress updated and detects completions and queued→running transitions.
  const activeJobIds = state.jobs
    .filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'completing')
    .map((j) => j.promptId)
    .sort()
    .join(',');

  // Ref tracks queued job IDs without requiring an extra effect dependency.
  // Updated every render so the polling closure always reads current queued IDs.
  const queuedJobIdsRef = useRef<Set<string>>(new Set());
  queuedJobIdsRef.current = new Set(
    state.jobs.filter((j) => j.status === 'queued').map((j) => j.promptId),
  );

  useEffect(() => {
    if (!activeJobIds) return;

    const knownActive = new Set(activeJobIds.split(',').filter(Boolean));
    // Snapshot queued IDs at effect-fire time; updated in-place as transitions are dispatched.
    const localQueuedIds = new Set(queuedJobIdsRef.current);

    const poll = async () => {
      try {
        const res = await fetch('/api/jobs/active');
        if (!res.ok) return;
        const { jobs: serverJobs } = await res.json() as { jobs: ActiveJobInfo[] };

        for (const sj of serverJobs) {
          if (!knownActive.has(sj.promptId)) continue;

          if (sj.status === 'running') {
            // If client had this job as queued but server says running, transition it.
            if (localQueuedIds.has(sj.promptId)) {
              dispatch({ type: 'TRANSITION_TO_RUNNING', promptId: sj.promptId, runningSince: sj.runningSince ?? Date.now() });
              localQueuedIds.delete(sj.promptId);
            }
            if (sj.progress) {
              dispatch({ type: 'UPDATE_PROGRESS', promptId: sj.promptId, progress: sj.progress });
            }
          } else if (sj.status === 'done') {
            dispatch({ type: 'COMPLETE_JOB', promptId: sj.promptId, generationId: sj.generationId });
            knownActive.delete(sj.promptId);
          } else if (sj.status === 'error') {
            dispatch({ type: 'FAIL_JOB', promptId: sj.promptId, errorMessage: sj.errorMessage ?? 'Failed' });
            knownActive.delete(sj.promptId);
          }
        }
      } catch { /* ignore poll errors */ }
    };

    const pollInterval = Number(process.env.NEXT_PUBLIC_QUEUE_POLL_INTERVAL_MS) || 5_000;
    const interval = setInterval(poll, pollInterval);
    return () => clearInterval(interval);
  }, [activeJobIds]);

  // ── permission request (called on first submit) ────────────────────────────
  const permRequestedRef = useRef(false);
  const requestPermissionIfNeeded = useCallback(() => {
    if (permRequestedRef.current) return;
    permRequestedRef.current = true;
    void requestNotificationPermission();
  }, []);

  // ── stable action creators ─────────────────────────────────────────────────
  const addJob = useCallback((job: ActiveJob) => dispatch({ type: 'ADD_JOB', job }), []);
  const updateProgress = useCallback((promptId: string, progress: { current: number; total: number }) =>
    dispatch({ type: 'UPDATE_PROGRESS', promptId, progress }), []);
  const setCompleting = useCallback((promptId: string) => dispatch({ type: 'SET_COMPLETING', promptId }), []);
  const completeJob = useCallback((promptId: string, generationId: string) =>
    dispatch({ type: 'COMPLETE_JOB', promptId, generationId }), []);
  const failJob = useCallback((promptId: string, errorMessage: string) =>
    dispatch({ type: 'FAIL_JOB', promptId, errorMessage }), []);
  const removeJob = useCallback((promptId: string) => dispatch({ type: 'REMOVE_JOB', promptId }), []);
  const toggleMute = useCallback(() => dispatch({ type: 'TOGGLE_MUTE' }), []);
  const dismissToast = useCallback((id: string) => dispatch({ type: 'DISMISS_TOAST', id }), []);

  return (
    <QueueContext.Provider value={{
      jobs: state.jobs,
      muted: state.muted,
      toasts: state.toasts,
      addJob,
      updateProgress,
      setCompleting,
      completeJob,
      failJob,
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
