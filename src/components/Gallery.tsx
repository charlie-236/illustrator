'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ImageModal from './ImageModal';
import type { GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';

interface GalleryResponse {
  records: GenerationRecord[];
  nextCursor: string | null;
}

interface Props {
  refreshToken: number;
  onRemix: (record: GenerationRecord) => void;
  onNavigateToProject?: (projectId: string) => void;
}

type MediaFilter = 'all' | 'image' | 'video';

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      fill={filled ? 'currentColor' : 'none'}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  );
}

export default function Gallery({ refreshToken, onRemix, onNavigateToProject }: Props) {
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [initialized, setInitialized] = useState(false);
  // null = closed; number = index of the item currently open in the modal
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Refs to allow the IntersectionObserver callback to always see current state
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const favoritesOnlyRef = useRef(false);
  const mediaFilterRef = useRef<MediaFilter>('all');

  cursorRef.current = cursor;
  hasMoreRef.current = hasMore;
  loadingRef.current = loading;
  favoritesOnlyRef.current = favoritesOnly;
  mediaFilterRef.current = mediaFilter;

  function clearPendingTimer() {
    if (pendingDeleteTimerRef.current !== null) {
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
  }

  useEffect(() => clearPendingTimer, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMoreRef.current) return;
    setLoading(true);
    loadingRef.current = true;
    try {
      const params = new URLSearchParams();
      if (cursorRef.current) params.set('cursor', cursorRef.current);
      if (favoritesOnlyRef.current) params.set('isFavorite', 'true');
      if (mediaFilterRef.current !== 'all') params.set('mediaType', mediaFilterRef.current);
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

  // Reset and reload from scratch when refreshToken, favoritesOnly, or mediaFilter changes
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(true);
    setInitialized(false);
    cursorRef.current = null;
    hasMoreRef.current = true;
    loadingRef.current = false;
  }, [refreshToken, favoritesOnly, mediaFilter]);

  // Fire initial load after reset
  useEffect(() => {
    if (!initialized) {
      setInitialized(true);
      void loadMore();
    }
  }, [initialized, loadMore]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMoreRef.current && !loadingRef.current) {
        void loadMore();
      }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  /** Raw delete — used by the modal (which handles its own confirm UI). */
  async function deleteById(id: string): Promise<void> {
    const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  async function handleFavoriteToggle(id: string): Promise<void> {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const newVal = !item.isFavorite;
    const res = await fetch(`/api/generation/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isFavorite: newVal }),
    });
    if (!res.ok) return;
    setItems((prev) => {
      const updated = prev.map((i) => i.id === id ? { ...i, isFavorite: newVal } : i);
      return favoritesOnly && !newVal ? updated.filter((i) => i.id !== id) : updated;
    });
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

  const filterBar = (
    <div className="flex items-center justify-between px-3 pt-3 pb-1 gap-2">
      {/* Media type filter */}
      <div className="flex items-center rounded-lg border border-zinc-700 overflow-hidden text-sm font-medium">
        {(['all', 'image', 'video'] as MediaFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setMediaFilter(f)}
            className={`min-h-12 px-4 transition-colors capitalize
              ${mediaFilter === f
                ? 'bg-violet-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
          >
            {f === 'all' ? 'All' : f === 'image' ? 'Images' : 'Videos'}
          </button>
        ))}
      </div>

      {/* Favorites filter */}
      <button
        onClick={() => setFavoritesOnly((f) => !f)}
        className={`min-h-12 px-4 flex items-center gap-2 rounded-lg text-sm font-medium transition-colors
          ${favoritesOnly
            ? 'bg-red-600/20 text-red-300 border border-red-600/40'
            : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700'}`}
      >
        <HeartIcon filled={favoritesOnly} />
        Favorites
      </button>
    </div>
  );

  if (!loading && items.length === 0 && !hasMore) {
    return (
      <>
        {filterBar}
        <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
          <p className="text-4xl mb-3">✦</p>
          <p>{favoritesOnly ? 'No favorites yet — tap the heart on any image.' : 'No generations yet — switch to Studio to create one.'}</p>
        </div>
      </>
    );
  }

  return (
    <>
      {filterBar}

      <div className="p-3 grid grid-cols-3 gap-1.5 sm:gap-2">
        {items.map((item, i) => (
          <div
            key={item.id}
            className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors group"
            onMouseLeave={() => { if (pendingDelete === item.id) setPendingDelete(null); }}
          >
            {/* Thumbnail — tap to open full-screen modal */}
            <button
              onClick={() => setSelectedIdx(i)}
              className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              aria-label={`View: ${item.promptPos.slice(0, 40)}`}
            >
              {item.mediaType === 'video' ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={imgSrc(item.filePath)}
                  preload="metadata"
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imgSrc(item.filePath)}
                  alt={item.promptPos.slice(0, 40)}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              )}
            </button>

            {/* Duration badge for video tiles */}
            {item.mediaType === 'video' && item.frames != null && item.fps != null && (
              <div className="absolute bottom-8 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium pointer-events-none select-none">
                {(item.frames / item.fps).toFixed(1)}s
              </div>
            )}

            {/* Heart — always visible when favorited, visible on hover otherwise */}
            <button
              onClick={(e) => { e.stopPropagation(); handleFavoriteToggle(item.id); }}
              className={`absolute top-1 right-1 min-h-12 min-w-12 flex items-center justify-center
                rounded-lg backdrop-blur-sm transition-all
                ${item.isFavorite
                  ? 'opacity-100 text-red-400 bg-black/40'
                  : 'opacity-0 group-hover:opacity-100 text-white/70 hover:text-red-400 bg-black/40'}`}
              title={item.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <HeartIcon filled={item.isFavorite} />
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

      {/* Sentinel for IntersectionObserver — triggers next page load */}
      <div ref={sentinelRef} className="h-1" />

      {!hasMore && items.length > 0 && (
        <p className="text-center text-xs text-zinc-600 pb-6">No more results</p>
      )}

      {selectedIdx !== null && (
        <ImageModal
          items={items}
          startIndex={selectedIdx}
          onClose={() => setSelectedIdx(null)}
          onRemix={onRemix}
          onDelete={deleteById}
          onFavoriteToggle={handleFavoriteToggle}
          onNavigateToProject={onNavigateToProject}
        />
      )}
    </>
  );
}
