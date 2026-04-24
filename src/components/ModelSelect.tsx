'use client';

import { useEffect, useState } from 'react';
import type { LoraEntry, ModelInfo } from '@/types';

interface Props {
  checkpoint: string;
  loras: LoraEntry[];
  onCheckpointChange: (v: string) => void;
  onLorasChange: (loras: LoraEntry[]) => void;
}

export default function ModelSelect({ checkpoint, loras, onCheckpointChange, onLorasChange }: Props) {
  const [models, setModels] = useState<ModelInfo>({ checkpoints: [], loras: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((data: ModelInfo) => {
        setModels(data);
        if (!checkpoint && data.checkpoints[0]) onCheckpointChange(data.checkpoints[0]);
      })
      .catch(() => setError('Could not reach ComfyUI'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addLora() {
    if (!models.loras[0]) return;
    onLorasChange([...loras, { name: models.loras[0], weight: 1.0 }]);
  }

  function updateLora(index: number, field: keyof LoraEntry, value: string | number) {
    onLorasChange(loras.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  }

  function removeLora(index: number) {
    onLorasChange(loras.filter((_, i) => i !== index));
  }

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Checkpoint */}
      <div>
        <label className="label">Checkpoint</label>
        <select
          value={checkpoint}
          onChange={(e) => onCheckpointChange(e.target.value)}
          disabled={loading}
          className="input-base"
        >
          {loading && <option>Loading…</option>}
          {models.checkpoints.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* LoRA stack */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="label mb-0">LoRAs</label>
          <button
            type="button"
            onClick={addLora}
            disabled={loading || models.loras.length === 0}
            className="text-xs px-2.5 py-1 rounded-lg bg-zinc-700 hover:bg-zinc-600
                       disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 transition-colors"
          >
            + Add LoRA
          </button>
        </div>

        {loras.length === 0 && (
          <p className="text-xs text-zinc-600 italic">No LoRAs — tap Add LoRA to stack one.</p>
        )}

        <div className="space-y-3">
          {loras.map((entry, i) => (
            <div key={i} className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
              {/* Dropdown + weight input + remove */}
              <div className="flex items-center gap-2">
                <select
                  value={entry.name}
                  onChange={(e) => updateLora(i, 'name', e.target.value)}
                  className="input-base flex-1 text-sm py-1.5"
                >
                  {models.loras.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={-2}
                  max={2}
                  step={0.05}
                  value={entry.weight}
                  onChange={(e) => updateLora(i, 'weight', parseFloat(e.target.value))}
                  className="input-base w-20 text-center text-sm py-1.5 px-1"
                />
                <button
                  type="button"
                  onClick={() => removeLora(i)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-700 transition-colors flex-shrink-0"
                  aria-label="Remove LoRA"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Weight slider */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 w-6 text-right tabular-nums">-2</span>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.05}
                  value={entry.weight}
                  onChange={(e) => updateLora(i, 'weight', parseFloat(e.target.value))}
                  className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700"
                />
                <span className="text-xs text-zinc-600 w-4 tabular-nums">2</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
