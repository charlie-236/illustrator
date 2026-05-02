'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';

interface GalleryResponse {
  records: GenerationRecord[];
  nextCursor: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (record: GenerationRecord) => void;
}

export default function GalleryPicker({ open, onClose, onSelect }: Props) {
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  cursorRef.current = cursor;
  hasMoreRef.current = hasMore;
  loadingRef.current = loading;

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMoreRef.current) return;
    setLoading(true);
    loadingRef.current = true;
    try {
      const params = new URLSearchParams({ mediaType: 'image' });
      if (cursorRef.current) params.set('cursor', cursorRef.current);
      const res = await fetch(`/api/gallery?${params}`);
      const data = await res.json() as GalleryResponse;
      setItems((prev) => [...prev, ...data.records]);
      setCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Reset and reload when opened
  useEffect(() => {
    if (open) {
      setItems([]);
      setCursor(null);
      setHasMore(true);
      setInitialized(false);
      cursorRef.current = null;
      hasMoreRef.current = true;
      loadingRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (open && !initialized) {
      setInitialized(true);
      void loadMore();
    }
  }, [open, initialized, loadMore]);

  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMoreRef.current && !loadingRef.current) {
        void loadMore();
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, loadMore]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80">
      <div className="bg-zinc-900 rounded-t-2xl sm:rounded-2xl border border-zinc-800 w-full max-w-lg flex flex-col max-h-[82vh] sm:max-h-[80vh]">

        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">Pick starting frame</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-12 min-w-12 flex items-center justify-center rounded-xl text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {!loading && items.length === 0 && !hasMore ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-500">
              <p className="text-center">No images in gallery yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { onSelect(item); onClose(); }}
                  className="aspect-square rounded-lg overflow-hidden border border-zinc-700 hover:border-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 transition-colors"
                  aria-label={item.promptPos.slice(0, 60)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imgSrc(item.filePath)}
                    alt={item.promptPos.slice(0, 40)}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
              {loading && Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-lg bg-zinc-800 animate-pulse" />
              ))}
            </div>
          )}
          <div ref={sentinelRef} className="h-1" />
        </div>

      </div>
    </div>
  );
}
