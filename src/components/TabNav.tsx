'use client';

import type { Tab } from '@/app/page';
import LoomLogo from '@/components/LoomLogo';

interface Props {
  active: Tab;
  onChange: (t: Tab) => void;
}

const TAB_LABELS: Record<Tab, string> = {
  projects: 'Projects',
  studio: 'Studio',
  gallery: 'Gallery',
  chats: 'Chats',
  models: 'Models',
  admin: 'Admin',
};

export default function TabNav({ active, onChange }: Props) {
  return (
    <header className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur border-b border-zinc-800">
      <div className="flex items-center px-4 h-14">
        <div className="flex items-center gap-2 mr-6 select-none">
          <LoomLogo size={28} />
          <span className="text-xl font-medium text-violet-400">Loom</span>
        </div>
        <nav className="flex gap-1">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => onChange(t)}
              className={`px-4 min-h-12 rounded-lg text-sm font-medium transition-colors ${
                active === t
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
