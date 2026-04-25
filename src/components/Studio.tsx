'use client';

import { useState, useRef, useEffect } from 'react';
import PromptArea from './PromptArea';
import ModelSelect from './ModelSelect';
import ParamSlider from './ParamSlider';
import GenerationProgress from './GenerationProgress';
import ImageModal from './ImageModal';
import type { CheckpointConfig, GenerationParams, GenerationRecord } from '@/types';
import { SAMPLERS, SCHEDULERS, RESOLUTIONS } from '@/types';

interface CheckpointDefaults {
  positivePrompt: string;
  negativePrompt: string;
}

const DEFAULTS: GenerationParams = {
  checkpoint: '',
  loras: [],
  positivePrompt: '',
  negativePrompt: '',
  width: 1024,
  height: 1024,
  steps: 35,
  cfg: 7,
  seed: -1,
  sampler: 'euler',
  scheduler: 'karras',
  batchSize: 1,
};

interface State {
  status: 'idle' | 'generating' | 'done' | 'error';
  progress: { value: number; max: number };
  /** All records returned by the completed generation (one per batch image). */
  records: GenerationRecord[];
  error: string;
  resolvedSeed: number;
}

interface Props {
  onGenerated: () => void;
  remixParams: GenerationParams | null;
  onRemixConsumed: () => void;
  onRemix: (record: GenerationRecord) => void;
}

export default function Studio({ onGenerated, remixParams, onRemixConsumed, onRemix }: Props) {
  const [p, setP] = useState<GenerationParams>(DEFAULTS);
  const [state, setState] = useState<State>({
    status: 'idle',
    progress: { value: 0, max: 0 },
    records: [],
    error: '',
    resolvedSeed: -1,
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStartIdx, setModalStartIdx] = useState(0);
  const sseRef = useRef<EventSource | null>(null);
  const [checkpointDefaults, setCheckpointDefaults] = useState<CheckpointDefaults | null>(null);

  // Apply remix data when received from Gallery
  useEffect(() => {
    if (!remixParams) return;
    setP({ ...remixParams, batchSize: remixParams.batchSize ?? 1 });
    onRemixConsumed();
    if (remixParams.checkpoint) {
      fetch(`/api/checkpoint-config?name=${encodeURIComponent(remixParams.checkpoint)}`)
        .then((r) => (r.ok ? r.json() as Promise<CheckpointConfig> : null))
        .then((config) => {
          setCheckpointDefaults(config
            ? { positivePrompt: config.defaultPositivePrompt, negativePrompt: config.defaultNegativePrompt }
            : null,
          );
        })
        .catch(() => {});
    } else {
      setCheckpointDefaults(null);
    }
  }, [remixParams, onRemixConsumed]);

  function update<K extends keyof GenerationParams>(key: K, val: GenerationParams[K]) {
    setP((prev) => ({ ...prev, [key]: val }));
  }

  async function handleCheckpointChange(newCheckpoint: string) {
    update('checkpoint', newCheckpoint);
    if (!newCheckpoint) { setCheckpointDefaults(null); return; }
    try {
      const res = await fetch(`/api/checkpoint-config?name=${encodeURIComponent(newCheckpoint)}`);
      if (!res.ok) { setCheckpointDefaults(null); return; }
      const config = await res.json() as CheckpointConfig;
      setCheckpointDefaults({
        positivePrompt: config.defaultPositivePrompt,
        negativePrompt: config.defaultNegativePrompt,
      });
      setP((s) => ({ ...s, width: config.defaultWidth, height: config.defaultHeight }));
    } catch {
      // non-critical
    }
  }

  async function handleGenerate() {
    if (state.status === 'generating') return;

    setState({
      status: 'generating',
      progress: { value: 0, max: p.steps },
      records: [],
      error: '',
      resolvedSeed: -1,
    });
    sseRef.current?.close();

    let promptId: string;
    let resolvedSeed: number;

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      if (!res.ok) {
        const { error } = await res.json() as { error: string };
        throw new Error(error);
      }
      ({ promptId, resolvedSeed } = await res.json() as { promptId: string; resolvedSeed: number });
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
      return;
    }

    setState((s) => ({ ...s, resolvedSeed }));

    const url = new URL(`/api/progress/${promptId}`, window.location.origin);
    url.searchParams.set('params', JSON.stringify(p));
    url.searchParams.set('seed', String(resolvedSeed));

    const sse = new EventSource(url.toString());
    sseRef.current = sse;

    sse.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data) as { value: number; max: number };
      setState((s) => ({ ...s, progress: d }));
    });

    sse.addEventListener('complete', (e) => {
      const d = JSON.parse(e.data) as { records: GenerationRecord[] };
      setState((s) => ({ ...s, status: 'done', records: d.records }));
      update('seed', resolvedSeed);
      sse.close();
      onGenerated();
    });

    sse.addEventListener('error', (e) => {
      const msg = e instanceof MessageEvent
        ? (JSON.parse(e.data) as { message: string }).message
        : 'Unknown error';
      setState((s) => ({ ...s, status: 'error', error: msg }));
      sse.close();
    });

    sse.onerror = () => {
      if (sse.readyState === EventSource.CLOSED) return;
      setState((s) => ({ ...s, status: 'error', error: 'SSE connection lost' }));
      sse.close();
    };
  }

  async function handleStudioDelete(id: string): Promise<void> {
    const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    setState((s) => {
      const remaining = s.records.filter((r) => r.id !== id);
      return {
        ...s,
        records: remaining,
        status: remaining.length === 0 ? 'idle' : s.status,
      };
    });
    onGenerated();
  }

  const isGenerating = state.status === 'generating';

  return (
    <div className="p-4 space-y-4">

      {/* ── During generation: progress bar ── */}
      {isGenerating && (
        <div className="card">
          <GenerationProgress value={state.progress.value} max={state.progress.max} />
        </div>
      )}

      {/* ── After generation: batch thumbnail grid ── */}
      {state.status === 'done' && state.records.length > 0 && (
        <div className="card">
          <div className="grid grid-cols-3 gap-1.5">
            {state.records.map((rec, i) => (
              <div
                key={rec.id}
                className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <button
                  className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  onClick={() => { setModalStartIdx(i); setModalOpen(true); }}
                  aria-label={`View generation ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={rec.filePath} alt="Generated" className="w-full h-full object-cover" />
                </button>
              </div>
            ))}
          </div>
          {state.resolvedSeed !== -1 && (
            <p className="text-xs text-zinc-400 mt-2 tabular-nums">Seed: {state.resolvedSeed}</p>
          )}
        </div>
      )}

      {state.status === 'error' && (
        <div className="card border-red-900 bg-red-950/30">
          <p className="text-red-400 text-sm">{state.error}</p>
        </div>
      )}

      {/* ── Prompts ── */}
      <div className="card space-y-3">
        <PromptArea
          label="Positive Prompt"
          value={p.positivePrompt}
          onChange={(v) => update('positivePrompt', v)}
          placeholder="A dog sunning itself on a shag rug."
          rows={4}
          hint={checkpointDefaults?.positivePrompt || undefined}
        />
        <PromptArea
          label="Negative Prompt"
          value={p.negativePrompt}
          onChange={(v) => update('negativePrompt', v)}
          rows={2}
          hint={checkpointDefaults?.negativePrompt || undefined}
        />
      </div>

      {/* ── Models ── */}
      <div className="card">
        <ModelSelect
          checkpoint={p.checkpoint}
          loras={p.loras}
          onCheckpointChange={handleCheckpointChange}
          onLorasChange={(v) => update('loras', v)}
        />
      </div>

      {/* ── Generation params ── */}
      <div className="card space-y-4">
        <ParamSlider label="Steps" value={p.steps} min={1} max={100} step={1} onChange={(v) => update('steps', v)} />
        <ParamSlider label="CFG Scale" value={p.cfg} min={1} max={20} step={0.5} onChange={(v) => update('cfg', v)} format={(v) => v.toFixed(1)} />
        <ParamSlider label="Batch Size" value={p.batchSize} min={1} max={4} step={1} onChange={(v) => update('batchSize', v)} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Resolution</label>
            <select
              value={`${p.width}x${p.height}`}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number);
                update('width', w);
                update('height', h);
              }}
              className="input-base"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Sampler</label>
            <select value={p.sampler} onChange={(e) => update('sampler', e.target.value)} className="input-base">
              {SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Scheduler</label>
          <select value={p.scheduler} onChange={(e) => update('scheduler', e.target.value)} className="input-base">
            {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <label className="label">Seed</label>
          <div className="flex gap-2">
            <input
              type="number"
              value={p.seed}
              onChange={(e) => update('seed', parseInt(e.target.value, 10))}
              className="input-base flex-1"
            />
            <button
              type="button"
              onClick={() => update('seed', -1)}
              disabled={p.seed === -1}
              title={p.seed === -1 ? 'Random mode active' : 'Reset to random'}
              className={`min-h-12 px-4 rounded-lg text-sm font-medium transition-all flex-shrink-0 border
                ${p.seed === -1
                  ? 'bg-violet-600/20 text-violet-300 border-violet-700/50 cursor-default'
                  : 'bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
            >
              {p.seed === -1 ? '🎲 Random' : '🎲 Randomize'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Sticky generate button ── */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-zinc-950/90 backdrop-blur border-t border-zinc-800 z-30 max-w-2xl mx-auto">
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !p.checkpoint}
          className="w-full py-4 rounded-xl font-semibold text-base transition-all
                     bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                     disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                     text-white shadow-lg shadow-violet-900/40"
        >
          {isGenerating
            ? `Generating… ${state.progress.value}/${state.progress.max}`
            : p.batchSize > 1
              ? `Generate ×${p.batchSize}`
              : 'Generate'}
        </button>
      </div>

      {/* ── Full-screen image modal ── */}
      {modalOpen && state.records.length > 0 && (
        <ImageModal
          items={state.records}
          startIndex={modalStartIdx}
          onClose={() => setModalOpen(false)}
          onRemix={(record) => { onRemix(record); setModalOpen(false); }}
          onDelete={handleStudioDelete}
        />
      )}
    </div>
  );
}
