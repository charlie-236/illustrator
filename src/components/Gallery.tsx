'use client';

import { useState, useEffect, useCallback } from 'react';
import ImageModal from './ImageModal';
import type { GenerationRecord } from '@/types';

interface GalleryResponse {
  items: GenerationRecord[];
  total: number;
  pages: number;
  page: number;
}

interface Props {
  refreshToken: number;
}

function imgSrc(filePath: string): string {
  // Old records stored /generations/... before the API-route fix; remap transparently.
  return filePath.startsWith('/generations/')
    ? `/api/images/${filePath.slice('/generations/'.length)}`
    : filePath;
}

export default function Gallery({ refreshToken }: Props) {
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GenerationRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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

  async function handleDelete(id: string) {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      return;
    }
    setPendingDelete(null);
    setDeleting(id);
    try {
      await fetch(`/api/generation/${id}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((item) => item.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  if (!loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-600">
        <p className="text-4xl mb-3">✦</p>
        <p>No generations yet — switch to Studio to create one.</p>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 grid grid-cols-3 gap-1.5 sm:gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-violet-500 transition-colors group"
            onMouseLeave={() => { if (pendingDelete === item.id) setPendingDelete(null); }}
          >
            <button
              onClick={() => setSelected(item)}
              className="w-full h-full focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc(item.filePath)}
                alt={item.promptPos.slice(0, 40)}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
              disabled={deleting === item.id}
              className={`absolute top-1.5 right-1.5 p-1.5 rounded-lg backdrop-blur-sm transition-all
                opacity-0 group-hover:opacity-100 focus:opacity-100
                ${pendingDelete === item.id
                  ? 'bg-red-600 text-white opacity-100'
                  : 'bg-black/60 text-zinc-300 hover:bg-red-600 hover:text-white'}
                disabled:opacity-50`}
              title={pendingDelete === item.id ? 'Tap again to confirm delete' : 'Delete'}
            >
              {pendingDelete === item.id ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
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
            className="px-6 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {selected && (
        <ImageModal record={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
