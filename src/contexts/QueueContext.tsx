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
  progress: { current: number; total: number } | null;
  status: 'running' | 'completing' | 'done' | 'error';
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
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId && j.status === 'running'
            ? { ...j, progress: action.progress }
            : j,
        ),
      };
    }

    case 'SET_COMPLETING': {
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.promptId === action.promptId && (j.status === 'running' || j.status === 'completing')
            ? { ...j, status: 'completing' }
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

  // ── poll /api/jobs/active while any jobs are running ──────────────────────
  // This provides refresh-survivability: after a page reload the client reattaches
  // to in-flight jobs via the mount-recovery effect in Studio, and the polling
  // here keeps progress updated and detects completions.
  const runningJobIds = state.jobs
    .filter((j) => j.status === 'running' || j.status === 'completing')
    .map((j) => j.promptId)
    .sort()
    .join(',');

  useEffect(() => {
    if (!runningJobIds) return;

    const knownRunning = new Set(runningJobIds.split(',').filter(Boolean));

    const poll = async () => {
      try {
        const res = await fetch('/api/jobs/active');
        if (!res.ok) return;
        const { jobs: serverJobs } = await res.json() as { jobs: ActiveJobInfo[] };

        for (const sj of serverJobs) {
          if (sj.status === 'running') {
            if (sj.progress && knownRunning.has(sj.promptId)) {
              dispatch({ type: 'UPDATE_PROGRESS', promptId: sj.promptId, progress: sj.progress });
            }
          } else if (sj.status === 'done' && knownRunning.has(sj.promptId)) {
            dispatch({ type: 'COMPLETE_JOB', promptId: sj.promptId, generationId: sj.generationId });
            knownRunning.delete(sj.promptId);
          } else if (sj.status === 'error' && knownRunning.has(sj.promptId)) {
            dispatch({ type: 'FAIL_JOB', promptId: sj.promptId, errorMessage: sj.errorMessage ?? 'Failed' });
            knownRunning.delete(sj.promptId);
          }
        }
      } catch { /* ignore poll errors */ }
    };

    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, [runningJobIds]);

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
