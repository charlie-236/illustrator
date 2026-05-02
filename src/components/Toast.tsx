'use client';

import { useEffect } from 'react';
import { useQueue, type ToastEntry } from '@/contexts/QueueContext';

interface ToastContainerProps {
  onNavigateToGallery: () => void;
}

export default function ToastContainer({ onNavigateToGallery }: ToastContainerProps) {
  const { toasts, dismissToast } = useQueue();

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed bottom-6 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          onDismiss={() => dismissToast(toast.id)}
          onNavigate={() => {
            dismissToast(toast.id);
            onNavigateToGallery();
          }}
        />
      ))}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
  onNavigate,
}: {
  toast: ToastEntry;
  onDismiss: () => void;
  onNavigate: () => void;
}) {
  // Auto-dismiss after 5 s
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5_000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const label = toast.mediaType === 'video' ? 'Video generated' : 'Image generated';

  return (
    <div
      className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl
                 bg-zinc-900 border border-zinc-700 shadow-2xl shadow-black/40
                 max-w-xs w-72 animate-in slide-in-from-right-4 fade-in duration-200"
    >
      {/* Icon */}
      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
        <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-100">{label}</p>
        {toast.promptSummary && (
          <p className="text-xs text-zinc-400 truncate">{toast.promptSummary}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={onNavigate}
          className="text-xs text-violet-400 hover:text-violet-300 min-h-8 px-2 rounded-lg hover:bg-violet-600/10 transition-colors"
        >
          View
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="min-h-8 min-w-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
