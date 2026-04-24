'use client';

import type { Tab } from '@/app/page';

interface Props {
  active: Tab;
  onChange: (t: Tab) => void;
}

export default function TabNav({ active, onChange }: Props) {
  return (
    <header className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur border-b border-zinc-800">
      <div className="flex items-center px-4 h-14">
        <span className="text-violet-400 font-bold tracking-tight mr-6 text-lg select-none">
          ✦ Illustrator
        </span>
        <nav className="flex gap-1">
          {(['studio', 'gallery'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => onChange(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                active === t
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
