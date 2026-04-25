'use client';

import { useState, useCallback } from 'react';
import Studio from '@/components/Studio';
import Gallery from '@/components/Gallery';
import ModelConfig from '@/components/ModelConfig';
import TabNav from '@/components/TabNav';
import type { GenerationParams, GenerationRecord, LoraEntry } from '@/types';

export type Tab = 'studio' | 'gallery' | 'models';

function parseLoras(loraStr: string | null): LoraEntry[] {
  if (!loraStr) return [];
  return loraStr.split(', ').flatMap((part) => {
    const m = part.match(/^(.+) \((-?\d+(?:\.\d+)?)\)$/);
    return m ? [{ name: m[1], weight: parseFloat(m[2]) }] : [];
  });
}

function recordToParams(record: GenerationRecord): GenerationParams {
  return {
    checkpoint: record.model,
    loras: parseLoras(record.lora),
    positivePrompt: record.promptPos,
    negativePrompt: record.promptNeg,
    width: record.width,
    height: record.height,
    steps: record.steps,
    cfg: record.cfg,
    seed: parseInt(record.seed, 10),
    sampler: record.sampler,
    scheduler: record.scheduler,
  };
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('studio');
  const [refreshGallery, setRefreshGallery] = useState(0);
  const [remixParams, setRemixParams] = useState<GenerationParams | null>(null);

  const handleRemix = useCallback((record: GenerationRecord) => {
    setRemixParams(recordToParams(record));
    setTab('studio');
  }, []);

  const handleRemixConsumed = useCallback(() => setRemixParams(null), []);

  return (
    <div className="flex flex-col min-h-screen max-w-2xl mx-auto">
      <TabNav active={tab} onChange={setTab} />
      <main className="flex-1 overflow-y-auto pb-24">
        <div className={tab === 'studio' ? '' : 'hidden'}>
          <Studio
            onGenerated={() => setRefreshGallery((n) => n + 1)}
            remixParams={remixParams}
            onRemixConsumed={handleRemixConsumed}
            onRemix={handleRemix}
          />
        </div>
        <div className={tab === 'gallery' ? '' : 'hidden'}>
          <Gallery refreshToken={refreshGallery} onRemix={handleRemix} />
        </div>
        <div className={tab === 'models' ? '' : 'hidden'}>
          <ModelConfig />
        </div>
      </main>
    </div>
  );
}
