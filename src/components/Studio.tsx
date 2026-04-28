'use client';

import { useState, useRef, useEffect } from 'react';
import PromptArea from './PromptArea';
import ModelSelect from './ModelSelect';
import ParamSlider from './ParamSlider';
import GenerationProgress from './GenerationProgress';
import ImageModal from './ImageModal';
import type { CheckpointConfig, GenerationParams, GenerationRecord, LoraConfig } from '@/types';
import { SAMPLERS, SCHEDULERS, RESOLUTIONS } from '@/types';
import type { Tab } from '@/app/page';
import { imgSrc } from '@/lib/imageSrc';
import ReferencePanel from './ReferencePanel';

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
  highResFix: false,
};

interface State {
  status: 'idle' | 'generating' | 'done' | 'error';
  progress: { value: number; max: number };
  records: GenerationRecord[];
  error: string;
  resolvedSeed: number;
}

interface Props {
  tab: Tab;
  onGenerated: () => void;
  remixParams: GenerationParams | null;
  onRemixConsumed: () => void;
  onRemix: (record: GenerationRecord) => void;
  modelConfigVersion: number;
}

export default function Studio({ tab, onGenerated, remixParams, onRemixConsumed, onRemix, modelConfigVersion }: Props) {
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const sseRef = useRef<EventSource | null>(null);
  const [checkpointDefaults, setCheckpointDefaults] = useState<CheckpointDefaults | null>(null);
  const [checkpointConfig, setCheckpointConfig] = useState<CheckpointConfig | null>(null);
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [mask, setMask] = useState<string | null>(null);
  const [baseImageDenoise, setBaseImageDenoise] = useState(0.65);
  const [faceReferences, setFaceReferences] = useState<string[]>([]);
  const [faceStrength, setFaceStrength] = useState(0.85);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const polishErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close drawer and clear stale post-generation results when navigating away from Studio
  useEffect(() => {
    if (tab !== 'studio') {
      setDrawerOpen(false);
      setState((s) => ({ ...s, records: [], status: s.status === 'done' ? 'idle' : s.status }));
    }
  }, [tab]);

  // Lift the Generate bar above the iOS soft keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function handleViewport() {
      const offset = window.innerHeight - vv!.height - vv!.offsetTop;
      setKeyboardOffset(Math.max(0, offset));
    }
    vv.addEventListener('resize', handleViewport);
    vv.addEventListener('scroll', handleViewport);
    return () => {
      vv.removeEventListener('resize', handleViewport);
      vv.removeEventListener('scroll', handleViewport);
    };
  }, []);

  // Apply remix data when received from Gallery
  useEffect(() => {
    if (!remixParams) return;
    setP({ ...remixParams, batchSize: remixParams.batchSize ?? 1 });
    onRemixConsumed();
    if (remixParams.checkpoint) {
      fetch(`/api/checkpoint-config?name=${encodeURIComponent(remixParams.checkpoint)}`)
        .then((r) => (r.ok ? r.json() as Promise<CheckpointConfig> : null))
        .then((config) => {
          setCheckpointConfig(config ?? null);
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
      if (!res.ok) { setCheckpointConfig(null); setCheckpointDefaults(null); return; }
      const config = await res.json() as CheckpointConfig;
      setCheckpointConfig(config);
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
    setDrawerOpen(false);

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
      const generateParams: GenerationParams = {
        ...p,
        baseImage: baseImage ?? undefined,
        mask: mask ?? undefined,
        denoise: baseImage ? baseImageDenoise : undefined,
        referenceImages: faceReferences.length > 0
          ? { images: faceReferences, strength: faceStrength }
          : undefined,
      };
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generateParams),
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

    const sse = new EventSource(`/api/progress/${promptId}`);
    sseRef.current = sse;

    sse.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data) as { value: number; max: number };
      setState((s) => ({ ...s, progress: d }));
    });

    sse.addEventListener('complete', (e) => {
      const d = JSON.parse(e.data) as { records: GenerationRecord[] };
      setState((s) => ({ ...s, status: 'done', records: d.records }));
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

  async function handlePolish() {
    if (polishing || isGenerating) return;
    setPolishing(true);
    setPolishError(null);
    if (polishErrorTimer.current) clearTimeout(polishErrorTimer.current);
    try {
      let triggerWords: string[] = [];
      if (p.loras.length > 0) {
        try {
          const loraConfigs = await fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>);
          const activeNames = new Set(p.loras.map((l) => l.name));
          triggerWords = loraConfigs
            .filter((c) => activeNames.has(c.loraName) && c.triggerWords?.trim())
            .flatMap((c) => c.triggerWords.split(',').map((w) => w.trim()).filter(Boolean));
        } catch {
          // non-critical — proceed without trigger words
        }
      }

      const res = await fetch('/api/generate/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positivePrompt: p.positivePrompt,
          negativePrompt: p.negativePrompt,
          ...(triggerWords.length > 0 && { triggerWords }),
        }),
      });
      const data = await res.json() as { positive?: string; negative?: string; error?: string };
      if (!res.ok || data.error) {
        const msg = data.error ?? `Error ${res.status}`;
        setPolishError(msg);
        polishErrorTimer.current = setTimeout(() => setPolishError(null), 5000);
        return;
      }
      if (data.positive) update('positivePrompt', data.positive);
      if (data.negative) update('negativePrompt', data.negative);
    } catch (err) {
      const msg = String(err);
      setPolishError(msg);
      polishErrorTimer.current = setTimeout(() => setPolishError(null), 5000);
    } finally {
      setPolishing(false);
    }
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
                  <img src={imgSrc(rec.filePath)} alt="Generated" className="w-full h-full object-cover" />
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

      {/* ── Reference panel (img2img + FaceID identity) ── */}
      <ReferencePanel
        baseImage={baseImage}
        mask={mask}
        baseImageDenoise={baseImageDenoise}
        faceReferences={faceReferences}
        faceStrength={faceStrength}
        selectedCheckpoint={p.checkpoint}
        checkpointConfigs={checkpointConfig ? [checkpointConfig] : []}
        onBaseImageChange={setBaseImage}
        onMaskChange={setMask}
        onBaseImageDenoiseChange={setBaseImageDenoise}
        onFaceReferencesChange={setFaceReferences}
        onFaceStrengthChange={setFaceStrength}
      />

      {/* ── Bottom bar: Settings toggle + Polish + Generate ── */}
      <div
        className="fixed bottom-0 left-0 right-0 px-4 pt-3 bg-zinc-950/90 backdrop-blur border-t border-zinc-800 z-30 max-w-2xl mx-auto transition-transform duration-150 ease-out"
        style={{
          transform: `translateY(-${keyboardOffset}px)`,
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        {polishError && (
          <p className="text-xs text-red-400 mb-2 truncate">✨ {polishError}</p>
        )}
        <div className="flex gap-3">
          {/* Settings */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open settings"
            className="min-h-12 min-w-14 flex flex-col items-center justify-center gap-0.5 rounded-xl
                       bg-zinc-800 hover:bg-zinc-700 active:scale-95
                       border border-zinc-700 text-zinc-300 transition-all flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
          </button>

          {/* Polish */}
          <button
            type="button"
            onClick={() => void handlePolish()}
            disabled={polishing || isGenerating || !p.positivePrompt.trim()}
            aria-label="Polish prompts with AI"
            className="min-h-12 min-w-14 flex flex-col items-center justify-center rounded-xl
                       bg-violet-600/10 hover:bg-violet-600/20 active:scale-95
                       border border-violet-600/30 hover:border-violet-500/50
                       text-violet-300 transition-all flex-shrink-0
                       disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {polishing ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
            ) : (
              <span className="text-lg leading-none">✨</span>
            )}
          </button>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !p.checkpoint}
            className="flex-1 py-4 rounded-xl font-semibold text-base transition-all
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
      </div>

      {/* ── Drawer overlay (fades in/out without layout recalculation) ── */}
      <div
        className={`fixed inset-0 bg-black/60 z-40 transition-opacity duration-300
          ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* ── Settings drawer (slides in from the right) ── */}
      <div
        className={`fixed top-0 right-0 bottom-0 w-80 max-w-[90vw] z-50 flex flex-col
                    bg-zinc-900 border-l border-zinc-800
                    transition-transform duration-300 ease-in-out
                    ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}
        aria-label="Generation settings"
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close settings"
            className="min-h-12 min-w-12 flex items-center justify-center rounded-xl
                       text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Drawer scrollable content */}
        <div className="flex-1 overflow-y-auto">

          {/* Models section */}
          <div className="px-4 pt-4 pb-5">
            <p className="label mb-3">Models</p>
            <ModelSelect
              checkpoint={p.checkpoint}
              loras={p.loras}
              onCheckpointChange={handleCheckpointChange}
              onLorasChange={(v) => update('loras', v)}
              refreshToken={modelConfigVersion}
            />
          </div>

          <div className="border-t border-zinc-800" />

          {/* Generation section */}
          <div className="px-4 pt-4 pb-5 space-y-4">
            <p className="label">Generation</p>

            <ParamSlider label="Steps" value={p.steps} min={1} max={100} step={1} onChange={(v) => update('steps', v)} />
            <ParamSlider label="CFG Scale" value={p.cfg} min={1} max={20} step={0.5} onChange={(v) => update('cfg', v)} format={(v) => v.toFixed(1)} />
            <ParamSlider label="Batch Size" value={p.batchSize} min={1} max={4} step={1} onChange={(v) => update('batchSize', v)} />

            <div>
              <label className="label">High-Res Fix</label>
              <button
                type="button"
                onClick={() => update('highResFix', !p.highResFix)}
                className={`min-h-12 w-full rounded-lg text-sm font-medium transition-all border
                  ${p.highResFix
                    ? 'bg-violet-600/20 text-violet-300 border-violet-700/50'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
              >
                {p.highResFix ? 'HRF On — 2× Upscale' : 'HRF Off'}
              </button>
            </div>
          </div>

          <div className="border-t border-zinc-800" />

          {/* Sampling section */}
          <div className="px-4 pt-4 pb-5 space-y-3">
            <p className="label">Sampling</p>

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

            <div>
              <label className="label">Scheduler</label>
              <select value={p.scheduler} onChange={(e) => update('scheduler', e.target.value)} className="input-base">
                {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="border-t border-zinc-800" />

          {/* Seed section */}
          <div className="px-4 pt-4 pb-8">
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
            {state.resolvedSeed !== -1 && (
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-zinc-400 tabular-nums">Last seed: {state.resolvedSeed}</span>
                <button
                  type="button"
                  onClick={() => update('seed', state.resolvedSeed)}
                  className="min-h-12 px-4 rounded-lg text-sm font-medium transition-all flex-shrink-0 border bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 active:scale-95"
                >
                  ♻ Reuse
                </button>
              </div>
            )}
          </div>

        </div>
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
