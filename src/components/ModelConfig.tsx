'use client';

import { useEffect, useState } from 'react';
import type { CheckpointConfig, LoraConfig, ModelInfo } from '@/types';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const CKPT_BLANK: Omit<CheckpointConfig, 'id' | 'checkpointName'> = {
  friendlyName: '',
  defaultWidth: 512,
  defaultHeight: 512,
  defaultPositivePrompt: '',
  defaultNegativePrompt: '',
};

const LORA_BLANK: Omit<LoraConfig, 'id' | 'loraName'> = {
  friendlyName: '',
  triggerWords: '',
  baseModel: '',
};

const BASE_MODEL_OPTIONS = ['', 'SD 1.5', 'SDXL', 'Pony', 'Flux.1', 'SD 3'];

export default function ModelConfig() {
  const [tab, setTab] = useState<'checkpoints' | 'loras'>('checkpoints');

  // ── Checkpoint state ──────────────────────────────────────────────
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [loras, setLoras] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');
  const [ckptForm, setCkptForm] = useState({ ...CKPT_BLANK });
  const [loadingCkptConfig, setLoadingCkptConfig] = useState(false);
  const [ckptStatus, setCkptStatus] = useState<SaveStatus>('idle');

  // ── LoRA state ────────────────────────────────────────────────────
  const [selectedLora, setSelectedLora] = useState('');
  const [loraForm, setLoraForm] = useState({ ...LORA_BLANK });
  const [loadingLoraConfig, setLoadingLoraConfig] = useState(false);
  const [loraStatus, setLoraStatus] = useState<SaveStatus>('idle');

  // Fetch model lists once
  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((data: ModelInfo) => {
        setCheckpoints(data.checkpoints);
        setLoras(data.loras);
        if (data.checkpoints[0]) setSelectedCheckpoint(data.checkpoints[0]);
        if (data.loras[0]) setSelectedLora(data.loras[0]);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  // Load checkpoint config when selection changes
  useEffect(() => {
    if (!selectedCheckpoint) return;
    setLoadingCkptConfig(true);
    setCkptStatus('idle');

    fetch(`/api/checkpoint-config?name=${encodeURIComponent(selectedCheckpoint)}`)
      .then((r) => (r.status === 404 ? null : r.json() as Promise<CheckpointConfig>))
      .then((config) => {
        setCkptForm(config
          ? {
              friendlyName: config.friendlyName,
              defaultWidth: config.defaultWidth,
              defaultHeight: config.defaultHeight,
              defaultPositivePrompt: config.defaultPositivePrompt,
              defaultNegativePrompt: config.defaultNegativePrompt,
            }
          : { ...CKPT_BLANK });
      })
      .catch(() => setCkptForm({ ...CKPT_BLANK }))
      .finally(() => setLoadingCkptConfig(false));
  }, [selectedCheckpoint]);

  // Load LoRA config when selection changes
  useEffect(() => {
    if (!selectedLora) return;
    setLoadingLoraConfig(true);
    setLoraStatus('idle');

    fetch(`/api/lora-config?name=${encodeURIComponent(selectedLora)}`)
      .then((r) => (r.status === 404 ? null : r.json() as Promise<LoraConfig>))
      .then((config) => {
        setLoraForm(config
          ? { friendlyName: config.friendlyName, triggerWords: config.triggerWords, baseModel: config.baseModel }
          : { ...LORA_BLANK });
      })
      .catch(() => setLoraForm({ ...LORA_BLANK }))
      .finally(() => setLoadingLoraConfig(false));
  }, [selectedLora]);

  async function saveCheckpoint() {
    if (!selectedCheckpoint) return;
    setCkptStatus('saving');
    try {
      const res = await fetch('/api/checkpoint-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointName: selectedCheckpoint, ...ckptForm }),
      });
      setCkptStatus(res.ok ? 'saved' : 'error');
    } catch {
      setCkptStatus('error');
    }
  }

  async function saveLora() {
    if (!selectedLora) return;
    setLoraStatus('saving');
    try {
      const res = await fetch('/api/lora-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loraName: selectedLora, ...loraForm }),
      });
      setLoraStatus(res.ok ? 'saved' : 'error');
    } catch {
      setLoraStatus('error');
    }
  }

  function ckptField<K extends keyof typeof ckptForm>(key: K, value: (typeof ckptForm)[K]) {
    setCkptForm((prev) => ({ ...prev, [key]: value }));
    setCkptStatus('idle');
  }

  function loraField<K extends keyof typeof loraForm>(key: K, value: (typeof loraForm)[K]) {
    setLoraForm((prev) => ({ ...prev, [key]: value }));
    setLoraStatus('idle');
  }

  return (
    <div className="p-4 space-y-4">
      <div className="card space-y-1">
        <h2 className="text-base font-semibold text-zinc-200">Model Settings</h2>
        <p className="text-xs text-zinc-500">
          Assign friendly names, trigger words, and defaults to your models.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-zinc-800/60 rounded-xl">
        {(['checkpoints', 'loras'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors capitalize
              ${tab === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Checkpoints tab ─────────────────────────────────────────── */}
      {tab === 'checkpoints' && (
        <>
          <div className="card">
            <label className="label">Checkpoint</label>
            <select
              value={selectedCheckpoint}
              onChange={(e) => setSelectedCheckpoint(e.target.value)}
              disabled={loadingModels}
              className="input-base"
            >
              {loadingModels && <option>Loading…</option>}
              {checkpoints.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className={`card space-y-4 transition-opacity ${loadingCkptConfig ? 'opacity-40 pointer-events-none' : ''}`}>
            <div>
              <label className="label">Friendly Name</label>
              <input
                type="text"
                value={ckptForm.friendlyName}
                onChange={(e) => ckptField('friendlyName', e.target.value)}
                placeholder="e.g. Realistic Vision v5"
                className="input-base"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Default Width</label>
                <input type="number" min={64} max={4096} step={8}
                  value={ckptForm.defaultWidth}
                  onChange={(e) => ckptField('defaultWidth', parseInt(e.target.value, 10))}
                  className="input-base"
                />
              </div>
              <div>
                <label className="label">Default Height</label>
                <input type="number" min={64} max={4096} step={8}
                  value={ckptForm.defaultHeight}
                  onChange={(e) => ckptField('defaultHeight', parseInt(e.target.value, 10))}
                  className="input-base"
                />
              </div>
            </div>

            <div>
              <label className="label">Default Positive Prompt</label>
              <p className="text-xs text-zinc-600 mb-1.5">
                Prepended to the positive prompt in every generation with this checkpoint.
              </p>
              <textarea rows={3}
                value={ckptForm.defaultPositivePrompt}
                onChange={(e) => ckptField('defaultPositivePrompt', e.target.value)}
                placeholder="score_9, score_8_up, masterpiece, …"
                className="input-base resize-none leading-relaxed"
              />
            </div>

            <div>
              <label className="label">Default Negative Prompt</label>
              <textarea rows={2}
                value={ckptForm.defaultNegativePrompt}
                onChange={(e) => ckptField('defaultNegativePrompt', e.target.value)}
                placeholder="score_1, score_2, score_3, …"
                className="input-base resize-none leading-relaxed"
              />
            </div>

            <SaveRow status={ckptStatus} onSave={saveCheckpoint} disabled={!selectedCheckpoint} />
          </div>
        </>
      )}

      {/* ── LoRAs tab ────────────────────────────────────────────────── */}
      {tab === 'loras' && (
        <>
          <div className="card">
            <label className="label">LoRA</label>
            <select
              value={selectedLora}
              onChange={(e) => setSelectedLora(e.target.value)}
              disabled={loadingModels}
              className="input-base"
            >
              {loadingModels && <option>Loading…</option>}
              {loras.length === 0 && !loadingModels && <option value="">No LoRAs found</option>}
              {loras.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>

          <div className={`card space-y-4 transition-opacity ${loadingLoraConfig ? 'opacity-40 pointer-events-none' : ''}`}>
            <div>
              <label className="label">Friendly Name</label>
              <input
                type="text"
                value={loraForm.friendlyName}
                onChange={(e) => loraField('friendlyName', e.target.value)}
                placeholder="e.g. Detail Tweaker"
                className="input-base"
              />
            </div>

            <div>
              <label className="label">Trigger Words</label>
              <p className="text-xs text-zinc-600 mb-1.5">
                Automatically appended to the positive prompt when this LoRA is used.
              </p>
              <textarea rows={2}
                value={loraForm.triggerWords}
                onChange={(e) => loraField('triggerWords', e.target.value)}
                placeholder="add_detail, detailed, …"
                className="input-base resize-none leading-relaxed"
              />
            </div>

            <div>
              <label className="label">Base Model</label>
              <select
                value={loraForm.baseModel}
                onChange={(e) => loraField('baseModel', e.target.value)}
                className="input-base"
              >
                {BASE_MODEL_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o || '— Not specified —'}</option>
                ))}
              </select>
            </div>

            <SaveRow status={loraStatus} onSave={saveLora} disabled={!selectedLora} />
          </div>
        </>
      )}
    </div>
  );
}

function SaveRow({ status, onSave, disabled }: { status: SaveStatus; onSave: () => void; disabled: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onSave}
        disabled={disabled || status === 'saving'}
        className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all
                   bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                   disabled:opacity-50 disabled:cursor-not-allowed text-white"
      >
        {status === 'saving' ? 'Saving…' : 'Save'}
      </button>
      {status === 'saved' && <span className="text-sm text-emerald-400 font-medium">✓ Saved</span>}
      {status === 'error' && <span className="text-sm text-red-400 font-medium">Save failed</span>}
    </div>
  );
}
