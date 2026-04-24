'use client';

import { useState } from 'react';
import Studio from '@/components/Studio';
import Gallery from '@/components/Gallery';
import TabNav from '@/components/TabNav';

export type Tab = 'studio' | 'gallery';

export default function Home() {
  const [tab, setTab] = useState<Tab>('studio');
  const [refreshGallery, setRefreshGallery] = useState(0);

  return (
    <div className="flex flex-col min-h-screen max-w-2xl mx-auto">
      <TabNav active={tab} onChange={setTab} />
      <main className="flex-1 overflow-y-auto pb-24">
        <div className={tab === 'studio' ? '' : 'hidden'}>
          <Studio onGenerated={() => setRefreshGallery((n) => n + 1)} />
        </div>
        <div className={tab === 'gallery' ? '' : 'hidden'}>
          <Gallery refreshToken={refreshGallery} />
        </div>
      </main>
    </div>
  );
}
