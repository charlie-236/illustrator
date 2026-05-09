'use client';

import { useState, useEffect, useRef } from 'react';
import { useQueue, type ActiveJob } from '@/contexts/QueueContext';

interface QueueTrayProps {
  onNavigateToGallery: () => void;
}

export default function QueueTray({ onNavigateToGallery }: QueueTrayProps) {
  const { jobs, muted, toggleMute, removeJob } = useQueue();
  const [expanded, setExpanded] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

  const activeCount = jobs.filter(
    (j) => j.status === 'pending' || j.status === 'queued' || j.status === 'running' || j.status === 'completing',
  ).length;

  // Close on click outside
  useEffect(() => {
    if (!expanded) return;
    function onMouseDown(e: MouseEvent) {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [expanded]);

  // Close on Escape
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setExpanded(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  if (jobs.length === 0) return null;

  return (
    <div ref={trayRef} className="relative">
      {/* ── Badge button ── */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="relative min-h-10 min-w-10 flex items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 active:scale-95 transition-all"
        aria-label={`${activeCount} active generation${activeCount !== 1 ? 's' : ''} — open queue`}
      >
        {/* Queue icon */}
        <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        {activeCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center px-1 leading-none">
            {activeCount}
          </span>
        )}
      </button>

      {/* ── Dropdown panel ── */}
      {expanded && (
        <div className="absolute right-0 top-12 w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* Tray header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Queue {jobs.length > 0 && `· ${jobs.length}`}
            </span>
            <button
              type="button"
              onClick={toggleMute}
              className="min-h-8 min-w-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-200"
              aria-label={muted ? 'Unmute chime' : 'Mute chime'}
              title={muted ? 'Unmute chime' : 'Mute chime'}
            >
              {muted ? (
                /* Speaker muted */
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              ) : (
                /* Speaker on */
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              )}
            </button>
          </div>

          {/* Job rows */}
          <div className="max-h-96 overflow-y-auto divide-y divide-zinc-800/60">
            {jobs.map((job) => {
              const pendingJobs = jobs.filter((j) => j.status === 'pending');
              return (
                <JobRow
                  key={job.queuedJobId}
                  job={job}
                  pendingTotal={pendingJobs.length}
                  onRemove={() => removeJob(job.queuedJobId)}
                  onAbort={async () => {
                    await fetch(`/api/queue/${job.queuedJobId}`, { method: 'DELETE' });
                  }}
                  onView={() => {
                    onNavigateToGallery();
                    setExpanded(false);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── individual job row ────────────────────────────────────────────────────────

function JobRow({
  job,
  pendingTotal,
  onRemove,
  onAbort,
  onView,
}: {
  job: ActiveJob;
  pendingTotal: number;
  onRemove: () => void;
  onAbort: () => Promise<void>;
  onView: () => void;
}) {
  const [liveElapsed, setLiveElapsed] = useState(() =>
    Math.floor((Date.now() - (job.runningSince ?? job.startedAt)) / 1000),
  );
  const [aborting, setAborting] = useState(false);

  useEffect(() => {
    if (job.status === 'done' || job.status === 'error' || job.status === 'pending' || job.status === 'queued') return;
    const base = job.runningSince ?? job.startedAt;
    const id = setInterval(() => {
      setLiveElapsed(Math.floor((Date.now() - base) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [job.runningSince, job.startedAt, job.status]);

  useEffect(() => {
    if (job.status === 'running' && job.runningSince !== null) {
      setLiveElapsed(Math.floor((Date.now() - job.runningSince) / 1000));
    }
  }, [job.status, job.runningSince]);

  const elapsed = (job.status === 'done' || job.status === 'error')
    ? Math.floor(((job.terminalAt ?? Date.now()) - (job.runningSince ?? job.startedAt)) / 1000)
    : liveElapsed;

  const isActive = job.status === 'pending' || job.status === 'queued' || job.status === 'running' || job.status === 'completing';

  return (
    <div className="px-4 py-3 space-y-1.5">
      {/* Row header: icon + prompt + actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 pt-0.5">
          {job.mediaType === 'stitch' ? (
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          ) : job.mediaType === 'video' ? (
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
          )}
          <span className="text-sm text-zinc-200 truncate leading-snug">
            {job.promptSummary || (
              job.mediaType === 'stitch' ? 'Project stitch' :
              job.mediaType === 'video' ? 'Video generation' : 'Image generation'
            )}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {job.status === 'done' && (
            <button
              type="button"
              onClick={onView}
              className="text-xs text-violet-400 hover:text-violet-300 min-h-8 px-2 rounded-lg hover:bg-violet-600/10 transition-colors"
            >
              View
            </button>
          )}
          {isActive && (
            <button
              type="button"
              disabled={aborting}
              onClick={async () => {
                setAborting(true);
                await onAbort();
              }}
              className="min-h-8 min-w-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
              aria-label="Abort generation"
              title="Abort"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {(job.status === 'done' || job.status === 'error') && (
            <button
              type="button"
              onClick={onRemove}
              className="min-h-8 min-w-8 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-zinc-600 hover:text-zinc-300 transition-colors"
              aria-label="Dismiss"
              title="Dismiss"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Pending (in our DB queue, not yet submitted to ComfyUI) */}
      {job.status === 'pending' && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">
            {pendingTotal > 1 && job.queuePosition != null
              ? `Pending (${job.queuePosition} of ${pendingTotal})`
              : 'Pending'}
          </p>
          {job.retryCount > 0 && (
            <p className="text-xs text-amber-500/80">Retry {job.retryCount} · {job.lastFailReason ?? 'retrying'}</p>
          )}
        </div>
      )}

      {/* Queued in ComfyUI (submitted but not yet executing) */}
      {job.status === 'queued' && (
        <p className="text-xs text-zinc-500">Queued at GPU</p>
      )}

      {/* Progress bar / status line for running/completing */}
      {(job.status === 'running' || job.status === 'completing') && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-zinc-500 tabular-nums">
            <span>
              {job.status === 'completing'
                ? 'Saving…'
                : job.progress
                  ? `${job.progress.current}/${job.progress.total} steps`
                  : 'Starting…'}
            </span>
            <span>{elapsed}s</span>
          </div>
          {job.progress && job.status !== 'completing' && (
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-600 rounded-full transition-all duration-300"
                style={{
                  width: job.progress.total > 0
                    ? `${Math.min(100, (job.progress.current / job.progress.total) * 100)}%`
                    : '0%',
                }}
              />
            </div>
          )}
          {job.status === 'completing' && (
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-violet-600/60 rounded-full animate-pulse w-full" />
            </div>
          )}
        </div>
      )}

      {/* Done checkmark */}
      {job.status === 'done' && (
        <p className="text-xs text-emerald-500">Complete · {elapsed}s</p>
      )}

      {/* Error message */}
      {job.status === 'error' && (
        <p className="text-xs text-red-400 break-words">{job.errorMessage ?? 'Failed'}</p>
      )}
    </div>
  );
}
