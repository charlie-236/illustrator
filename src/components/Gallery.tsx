'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ImageModal from './ImageModal';
import type { GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';

interface GalleryResponse {
  items: GenerationRecord[];
  total: number;
  pages: number;
  page: number;
}

interface Props {
  refreshToken: number;
  onRemix: (record: GenerationRecord) => void;
}

export default function Gallery({ refreshToken, onRemix }: Props) {
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  // null = closed; number = index of the item currently open in the modal
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearPendingTimer() {
    if (pendingDeleteTimerRef.current !== null) {
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
  }

  // Clear any armed delete timer on unmount
  useEffect(() => clearPendingTimer, []);

  const load = useCallback(async (p: number, reset = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gallery?page=${p}&limit=20`);
      const data = await res.json() as GalleryResponse;
      setItems((prev) => reset ? data.items : [...prev, ...data.items]);
      setPages(data.pages);
      setPage(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(1, true);
  }, [load, refreshToken]);

  /** Raw delete — no two-tap; used by the modal (which handles its own confirm UI). */
  async function deleteById(id: string): Promise<void> {
    const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  /** Two-tap confirm delete for thumbnail action strips. */
  async function handleDelete(id: string) {
    if (pendingDelete !== id) {
      clearPendingTimer();
      setPendingDelete(id);
      pendingDeleteTimerRef.current = setTimeout(() => {
        setPendingDelete(null);
        pendingDeleteTimerRef.current = null;
      }, 3500);
      return;
    }
    clearPendingTimer();
    setPendingDelete(null);
    setDeleting(id);
    try {
      await deleteById(id);
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setDeleting(null);
    }
  }

  if (!loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
        <p className="text-4xl mb-3">✦</p>
        <p>No generations yet — switch to Studio to create one.</p>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 grid grid-cols-3 gap-1.5 sm:gap-2">
        {items.map((item, i) => (
          <div
            key={item.id}
            className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors group"
            onMouseLeave={() => { if (pendingDelete === item.id) setPendingDelete(null); }}
          >
            {/* Image — tap to open full-screen modal */}
            <button
              onClick={() => setSelectedIdx(i)}
              className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              aria-label={`View: ${item.promptPos.slice(0, 40)}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc(item.filePath)}
                alt={item.promptPos.slice(0, 40)}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>

            {/* Action strip — revealed on hover/focus-within */}
            <div className="absolute bottom-0 left-0 right-0 flex items-stretch
                            opacity-0 pointer-events-none
                            group-hover:opacity-100 group-hover:pointer-events-auto
                            group-focus-within:opacity-100 group-focus-within:pointer-events-auto
                            transition-opacity">
              {/* Remix */}
              <button
                onClick={(e) => { e.stopPropagation(); onRemix(item); }}
                className="flex-1 min-h-12 bg-violet-600/90 backdrop-blur-sm text-white
                           flex items-center justify-center
                           hover:bg-violet-500 active:bg-violet-700 transition-colors"
                title="Send to Studio"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>

              {/* Delete (two-tap on thumbnail strip) */}
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                disabled={deleting === item.id}
                className={`min-h-12 min-w-12 backdrop-blur-sm flex items-center justify-center transition-colors disabled:opacity-50
                  ${pendingDelete === item.id
                    ? 'bg-red-600 text-white'
                    : 'bg-zinc-900/85 text-zinc-300 hover:bg-red-600/80 hover:text-white'}`}
                title={pendingDelete === item.id ? 'Tap again to confirm delete' : 'Delete'}
              >
                {pendingDelete === item.id ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        ))}

        {loading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-lg bg-zinc-800 animate-pulse" />
        ))}
      </div>

      {page < pages && !loading && (
        <div className="flex justify-center p-4">
          <button
            onClick={() => load(page + 1)}
            className="px-6 min-h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {selectedIdx !== null && (
        <ImageModal
          items={items}
          startIndex={selectedIdx}
          onClose={() => setSelectedIdx(null)}
          onRemix={onRemix}
          onDelete={deleteById}
        />
      )}
    </>
  );
}
