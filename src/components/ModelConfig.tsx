'use client';

import { useEffect, useState } from 'react';
import type { CheckpointConfig, ModelInfo } from '@/types';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const BLANK: Omit<CheckpointConfig, 'id' | 'checkpointName'> = {
  defaultWidth: 512,
  defaultHeight: 512,
  defaultPositivePrompt: '',
  defaultNegativePrompt: '',
};

export default function ModelConfig() {
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');

  const [form, setForm] = useState({ ...BLANK });
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Fetch checkpoint list once on mount
  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((data: ModelInfo) => {
        setCheckpoints(data.checkpoints);
        if (data.checkpoints[0]) setSelectedCheckpoint(data.checkpoints[0]);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  // Fetch saved config whenever the selected checkpoint changes
  useEffect(() => {
    if (!selectedCheckpoint) return;
    setLoadingConfig(true);
    setSaveStatus('idle');

    fetch(`/api/checkpoint-config?name=${encodeURIComponent(selectedCheckpoint)}`)
      .then((r) => {
        if (r.status === 404) return null;
        return r.json() as Promise<CheckpointConfig>;
      })
      .then((config) => {
        if (config) {
          setForm({
            defaultWidth: config.defaultWidth,
            defaultHeight: config.defaultHeight,
            defaultPositivePrompt: config.defaultPositivePrompt,
            defaultNegativePrompt: config.defaultNegativePrompt,
          });
        } else {
          setForm({ ...BLANK });
        }
      })
      .catch(() => setForm({ ...BLANK }))
      .finally(() => setLoadingConfig(false));
  }, [selectedCheckpoint]);

  async function handleSave() {
    if (!selectedCheckpoint) return;
    setSaveStatus('saving');
    try {
      const res = await fetch('/api/checkpoint-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointName: selectedCheckpoint, ...form }),
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
    } catch {
      setSaveStatus('error');
    }
  }

  function field<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveStatus('idle');
  }

  return (
    <div className="p-4 space-y-4">
      <div className="card space-y-1">
        <h2 className="text-base font-semibold text-zinc-200">Model Configuration</h2>
        <p className="text-xs text-zinc-500">
          Save per-checkpoint defaults. Selecting a checkpoint in Studio auto-fills these values.
        </p>
      </div>

      {/* Checkpoint selector */}
      <div className="card">
        <label className="label">Checkpoint</label>
        <select
          value={selectedCheckpoint}
          onChange={(e) => setSelectedCheckpoint(e.target.value)}
          disabled={loadingModels}
          className="input-base"
        >
          {loadingModels && <option>Loading…</option>}
          {checkpoints.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Config fields */}
      <div className={`card space-y-4 transition-opacity ${loadingConfig ? 'opacity-40 pointer-events-none' : ''}`}>
        {/* Resolution */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Default Width</label>
            <input
              type="number"
              min={64}
              max={4096}
              step={8}
              value={form.defaultWidth}
              onChange={(e) => field('defaultWidth', parseInt(e.target.value, 10))}
              className="input-base"
            />
          </div>
          <div>
            <label className="label">Default Height</label>
            <input
              type="number"
              min={64}
              max={4096}
              step={8}
              value={form.defaultHeight}
              onChange={(e) => field('defaultHeight', parseInt(e.target.value, 10))}
              className="input-base"
            />
          </div>
        </div>

        {/* Positive prompt */}
        <div>
          <label className="label">Default Positive Prompt</label>
          <p className="text-xs text-zinc-600 mb-1.5">
            Trigger words and style tags (e.g. <span className="font-mono">score_9, score_8_up</span>).
            Prepended to your prompt in Studio.
          </p>
          <textarea
            rows={3}
            value={form.defaultPositivePrompt}
            onChange={(e) => field('defaultPositivePrompt', e.target.value)}
            placeholder="score_9, score_8_up, masterpiece, …"
            className="input-base resize-none leading-relaxed"
          />
        </div>

        {/* Negative prompt */}
        <div>
          <label className="label">Default Negative Prompt</label>
          <p className="text-xs text-zinc-600 mb-1.5">Prepended to your negative prompt in Studio.</p>
          <textarea
            rows={2}
            value={form.defaultNegativePrompt}
            onChange={(e) => field('defaultNegativePrompt', e.target.value)}
            placeholder="score_1, score_2, score_3, …"
            className="input-base resize-none leading-relaxed"
          />
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={!selectedCheckpoint || saveStatus === 'saving'}
            className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all
                       bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                       disabled:opacity-50 disabled:cursor-not-allowed
                       text-white"
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Save Configuration'}
          </button>
          {saveStatus === 'saved' && (
            <span className="text-sm text-emerald-400 font-medium">✓ Saved</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-sm text-red-400 font-medium">Save failed</span>
          )}
        </div>
      </div>
    </div>
  );
}
