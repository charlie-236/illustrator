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
          <button
            key={item.id}
            onClick={() => setSelected(item)}
            className="aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-violet-500 transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500"
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
