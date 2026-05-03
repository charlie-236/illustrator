'use client';

import { useState } from 'react';
import type { ProjectDetail } from '@/types';

interface Props {
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
}

interface Form {
  name: string;
  description: string;
  styleNote: string;
  defaultFrames: string;
  defaultSteps: string;
  defaultCfg: string;
  defaultWidth: string;
  defaultHeight: string;
}

const VIDEO_RESOLUTIONS = [
  { label: '1280×704', w: 1280, h: 704 },
  { label: '768×768', w: 768, h: 768 },
  { label: '704×1280', w: 704, h: 1280 },
];

export default function NewProjectModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<Form>({
    name: '',
    description: '',
    styleNote: '',
    defaultFrames: '',
    defaultSteps: '',
    defaultCfg: '',
    defaultWidth: '',
    defaultHeight: '',
  });
  const [showDefaults, setShowDefaults] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof Form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name: form.name.trim() };
    if (form.description.trim()) body.description = form.description.trim();
    if (form.styleNote.trim()) body.styleNote = form.styleNote.trim();
    if (form.defaultFrames) body.defaultFrames = parseInt(form.defaultFrames, 10);
    if (form.defaultSteps) body.defaultSteps = parseInt(form.defaultSteps, 10);
    if (form.defaultCfg) body.defaultCfg = parseFloat(form.defaultCfg);
    if (form.defaultWidth) body.defaultWidth = parseInt(form.defaultWidth, 10);
    if (form.defaultHeight) body.defaultHeight = parseInt(form.defaultHeight, 10);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to create project'); return; }
      onCreated(data as ProjectDetail);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">New Project</h2>
          <button onClick={onClose} className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <div>
            <label className="label block mb-1">Name *</label>
            <input
              className="input-base"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Sci-fi short, Sunset walk…"
              autoFocus
            />
          </div>

          <div>
            <label className="label block mb-1">Description</label>
            <textarea
              className="input-base resize-none"
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Short description of the project"
            />
          </div>

          <div>
            <label className="label block mb-1">Style note</label>
            <textarea
              className="input-base resize-none"
              rows={3}
              value={form.styleNote}
              onChange={(e) => set('styleNote', e.target.value)}
              placeholder="Creative anchor — what is this project about? Tone, visual style, key constraints…"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowDefaults((s) => !s)}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 min-h-12"
          >
            <svg
              className={`w-4 h-4 transition-transform ${showDefaults ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Default settings
          </button>

          {showDefaults && (
            <div className="space-y-4 pl-4 border-l-2 border-zinc-700">
              <div>
                <label className="label block mb-1">Resolution</label>
                <div className="flex gap-2 flex-wrap">
                  {VIDEO_RESOLUTIONS.map((r) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => { set('defaultWidth', String(r.w)); set('defaultHeight', String(r.h)); }}
                      className={`px-3 min-h-12 rounded-lg text-sm border transition-colors
                        ${form.defaultWidth === String(r.w) && form.defaultHeight === String(r.h)
                          ? 'border-violet-500 bg-violet-600/20 text-violet-300'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1">Default frames</label>
                  <input
                    className="input-base"
                    type="number"
                    min={17} max={121} step={8}
                    value={form.defaultFrames}
                    onChange={(e) => set('defaultFrames', e.target.value)}
                    placeholder="57"
                  />
                </div>
                <div>
                  <label className="label block mb-1">Default steps</label>
                  <input
                    className="input-base"
                    type="number"
                    min={4} max={40} step={2}
                    value={form.defaultSteps}
                    onChange={(e) => set('defaultSteps', e.target.value)}
                    placeholder="20"
                  />
                </div>
              </div>

              <div>
                <label className="label block mb-1">Default CFG</label>
                <input
                  className="input-base"
                  type="number"
                  min={1} max={10} step={0.1}
                  value={form.defaultCfg}
                  onChange={(e) => set('defaultCfg', e.target.value)}
                  placeholder="3.5"
                />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-12 rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
