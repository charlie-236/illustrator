'use client';

import { useEffect, useState } from 'react';
import type { ModelInfo } from '@/types';

interface Props {
  checkpoint: string;
  lora: string;
  loraStrength: number;
  onCheckpointChange: (v: string) => void;
  onLoraChange: (v: string) => void;
  onLoraStrengthChange: (v: number) => void;
}

export default function ModelSelect({
  checkpoint, lora, loraStrength,
  onCheckpointChange, onLoraChange, onLoraStrengthChange,
}: Props) {
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

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  return (
    <div className="space-y-3">
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

      <div>
        <label className="label">LoRA <span className="normal-case text-zinc-600 font-normal">(optional)</span></label>
        <select
          value={lora}
          onChange={(e) => onLoraChange(e.target.value)}
          disabled={loading}
          className="input-base"
        >
          <option value="">— none —</option>
          {models.loras.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {lora && (
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="label mb-0">LoRA Strength</label>
            <span className="text-xs text-zinc-400 tabular-nums">{loraStrength.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0} max={2} step={0.05}
            value={loraStrength}
            onChange={(e) => onLoraStrengthChange(parseFloat(e.target.value))}
            className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700"
          />
        </div>
      )}
    </div>
  );
}
