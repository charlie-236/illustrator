'use client';

import { useState, useRef } from 'react';
import PromptArea from './PromptArea';
import ModelSelect from './ModelSelect';
import ParamSlider from './ParamSlider';
import GenerationProgress from './GenerationProgress';
import type { GenerationParams, SSEEvent } from '@/types';
import { SAMPLERS, SCHEDULERS, RESOLUTIONS } from '@/types';

const DEFAULTS: GenerationParams = {
  checkpoint: '',
  loras: [],
  positivePrompt: '',
  negativePrompt: 'nsfw, ugly, blurry, low quality, watermark, text, signature',
  width: 512,
  height: 512,
  steps: 20,
  cfg: 7,
  seed: -1,
  sampler: 'euler',
  scheduler: 'karras',
};

interface State {
  status: 'idle' | 'generating' | 'done' | 'error';
  progress: { value: number; max: number };
  imageUrl: string;
  error: string;
  resolvedSeed: number;
}

export default function Studio({ onGenerated }: { onGenerated: () => void }) {
  const [p, setP] = useState<GenerationParams>(DEFAULTS);
  const [state, setState] = useState<State>({
    status: 'idle',
    progress: { value: 0, max: 0 },
    imageUrl: '',
    error: '',
    resolvedSeed: -1,
  });
  const sseRef = useRef<EventSource | null>(null);

  function update<K extends keyof GenerationParams>(key: K, val: GenerationParams[K]) {
    setP((prev) => ({ ...prev, [key]: val }));
  }

  async function handleGenerate() {
    if (state.status === 'generating') return;

    setState({ status: 'generating', progress: { value: 0, max: p.steps }, imageUrl: '', error: '', resolvedSeed: -1 });
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
      const d = JSON.parse(e.data) as { imageUrl: string; generationId: string };
      setState((s) => ({ ...s, status: 'done', imageUrl: d.imageUrl }));
      sse.close();
      onGenerated();
    });

    sse.addEventListener('error', (e) => {
      const msg = e instanceof MessageEvent ? (JSON.parse(e.data) as { message: string }).message : 'Unknown error';
      setState((s) => ({ ...s, status: 'error', error: msg }));
      sse.close();
    });

    sse.onerror = () => {
      if (sse.readyState === EventSource.CLOSED) return;
      setState((s) => ({ ...s, status: 'error', error: 'SSE connection lost' }));
      sse.close();
    };
  }

  const isGenerating = state.status === 'generating';

  return (
    <div className="p-4 space-y-4">
      {/* Progress / result — top so the keyboard never obscures it */}
      {(isGenerating || state.status === 'done') && (
        <div className="card">
          <GenerationProgress
            value={state.progress.value}
            max={state.progress.max}
            imageUrl={state.imageUrl}
          />
          {state.status === 'done' && state.resolvedSeed !== -1 && (
            <p className="text-xs text-zinc-500 mt-2 text-center tabular-nums">Seed: {state.resolvedSeed}</p>
          )}
        </div>
      )}

      {state.status === 'error' && (
        <div className="card border-red-900 bg-red-950/30">
          <p className="text-red-400 text-sm">{state.error}</p>
        </div>
      )}

      {/* Prompts */}
      <div className="card space-y-3">
        <PromptArea
          label="Positive Prompt"
          value={p.positivePrompt}
          onChange={(v) => update('positivePrompt', v)}
          placeholder="masterpiece, best quality, …"
          rows={4}
        />
        <PromptArea
          label="Negative Prompt"
          value={p.negativePrompt}
          onChange={(v) => update('negativePrompt', v)}
          rows={2}
        />
      </div>

      {/* Models */}
      <div className="card">
        <ModelSelect
          checkpoint={p.checkpoint}
          loras={p.loras}
          onCheckpointChange={(v) => update('checkpoint', v)}
          onLorasChange={(v) => update('loras', v)}
        />
      </div>

      {/* Generation params */}
      <div className="card space-y-4">
        <ParamSlider label="Steps" value={p.steps} min={1} max={100} step={1} onChange={(v) => update('steps', v)} />
        <ParamSlider label="CFG Scale" value={p.cfg} min={1} max={20} step={0.5} onChange={(v) => update('cfg', v)} format={(v) => v.toFixed(1)} />

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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Scheduler</label>
            <select value={p.scheduler} onChange={(e) => update('scheduler', e.target.value)} className="input-base">
              {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="label">Seed <span className="normal-case text-zinc-600 font-normal">(-1 = random)</span></label>
            <input
              type="number"
              value={p.seed}
              onChange={(e) => update('seed', parseInt(e.target.value, 10))}
              className="input-base"
            />
          </div>
        </div>
      </div>

      {/* Sticky generate button */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-zinc-950/90 backdrop-blur border-t border-zinc-800 z-30 max-w-2xl mx-auto">
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !p.checkpoint}
          className="w-full py-4 rounded-xl font-semibold text-base transition-all
                     bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                     disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                     text-white shadow-lg shadow-violet-900/40"
        >
          {isGenerating ? `Generating… ${state.progress.value}/${state.progress.max}` : 'Generate'}
        </button>
      </div>
    </div>
  );
}
