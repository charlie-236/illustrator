'use client';

import { useEffect, useRef, useState } from 'react';
import type { GenerationRecord } from '@/types';

function imgSrc(filePath: string): string {
  return filePath.startsWith('/generations/')
    ? `/api/images/${filePath.slice('/generations/'.length)}`
    : filePath;
}

interface Props {
  items: GenerationRecord[];
  startIndex: number;
  onClose: () => void;
  onRemix: (record: GenerationRecord) => void;
  /** Parent handles the API call. Throw on failure to keep the modal open. */
  onDelete: (id: string) => Promise<void>;
}

export default function ImageModal({ items: initialItems, startIndex, onClose, onRemix, onDelete }: Props) {
  const [items, setItems] = useState(initialItems);
  const [idx, setIdx] = useState(Math.min(startIndex, Math.max(0, initialItems.length - 1)));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // Keep a ref to items.length so the keyboard handler never captures a stale value
  const itemsLenRef = useRef(items.length);
  useEffect(() => { itemsLenRef.current = items.length; }, [items.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, itemsLenRef.current - 1));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reset confirmation state whenever the user navigates to a different image
  useEffect(() => { setConfirmDelete(false); }, [idx]);

  const record = items[idx] ?? null;

  function goTo(newIdx: number) {
    if (newIdx >= 0 && newIdx < items.length) setIdx(newIdx);
  }

  async function handleDelete() {
    if (!record) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await onDelete(record.id);
      const next = items.filter((_, i) => i !== idx);
      if (next.length === 0) { onClose(); return; }
      setItems(next);
      setIdx((prev) => Math.min(prev, next.length - 1));
      setConfirmDelete(false);
    } catch {
      // delete failed — stay put, user can retry
    } finally {
      setDeleting(false);
    }
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 48) return;
    if (dx < 0) goTo(idx + 1);
    else goTo(idx - 1);
  }

  if (!record) return null;

  const modelShort = record.model.split('/').pop()?.replace(/\.(safetensors|ckpt|pt)$/i, '') ?? record.model;
  const date = new Date(record.createdAt).toLocaleString();

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">

      {/* ── Top bar: Close · counter · Remix · Delete ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-950 border-b border-zinc-800 flex-shrink-0">

        <button
          onClick={onClose}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-xl text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors flex-shrink-0"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <span className="flex-1 text-center text-sm text-zinc-400">
          {items.length > 1 ? `${idx + 1} / ${items.length}` : ''}
        </span>

        {/* Remix */}
        <button
          onClick={() => { onRemix(record); onClose(); }}
          className="min-h-12 px-4 flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-semibold text-sm transition-colors flex-shrink-0"
          aria-label="Remix — send params to Studio"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Remix
        </button>

        {/* Delete (two-tap confirm) */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={`min-h-12 px-4 flex items-center gap-2 rounded-xl font-semibold text-sm transition-colors flex-shrink-0 disabled:opacity-50
            ${confirmDelete
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'}`}
          aria-label={confirmDelete ? 'Confirm delete' : 'Delete'}
        >
          {confirmDelete ? (
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          )}
          {confirmDelete ? 'Confirm' : 'Delete'}
        </button>
      </div>

      {/* ── Image area ── */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden bg-black"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={record.id}
          src={imgSrc(record.filePath)}
          alt={record.promptPos.slice(0, 80)}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />

        {idx > 0 && (
          <button
            onClick={() => goTo(idx - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-black/55 hover:bg-black/80 text-white backdrop-blur-sm transition-colors"
            aria-label="Previous image"
          >
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {idx < items.length - 1 && (
          <button
            onClick={() => goTo(idx + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-black/55 hover:bg-black/80 text-white backdrop-blur-sm transition-colors"
            aria-label="Next image"
          >
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Bottom metadata ── */}
      <div className="bg-zinc-950 border-t border-zinc-800 px-4 py-3 flex-shrink-0 space-y-1.5">
        <p className="text-sm text-zinc-200 leading-relaxed line-clamp-2">{record.promptPos}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span className="text-xs text-zinc-400">{modelShort}</span>
          {record.lora && <span className="text-xs text-zinc-400">{record.lora}</span>}
          <span className="text-xs text-zinc-400">{record.width}×{record.height}</span>
          <span className="text-xs text-zinc-400">{record.steps} steps</span>
          <span className="text-xs text-zinc-400">CFG {record.cfg}</span>
          <span className="text-xs text-zinc-400 tabular-nums">Seed {record.seed}</span>
          <span className="text-xs text-zinc-400">{record.sampler}/{record.scheduler}</span>
        </div>
        <p className="text-xs text-zinc-600">{date}</p>
      </div>
    </div>
  );
}
