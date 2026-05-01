'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointConfig, LoraConfig, LoraEntry, ModelInfo } from '@/types';

interface Props {
  checkpoint: string;
  loras: LoraEntry[];
  onCheckpointChange: (v: string) => void;
  onLorasChange: (loras: LoraEntry[]) => void;
  refreshToken?: number;
}

function ChevronDown() {
  return (
    <svg className="w-4 h-4 text-zinc-500 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

interface SheetProps {
  title: string;
  items: string[];
  selected: string;
  nameMap: Record<string, string>;
  onSelect: (value: string) => void;
  onClose: () => void;
  emptyMessage?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Optional base-model badge text per raw item key */
  badgeMap?: Record<string, string>;
  /** Items whose base model matches the active checkpoint — sorted to top */
  prioritySet?: Set<string>;
}

function ModelSheet({ title, items, selected, nameMap, onSelect, onClose, emptyMessage, onRefresh, refreshing, badgeMap, prioritySet }: SheetProps) {
  const sorted = [...items].sort((a, b) => {
    const aPri = prioritySet?.has(a) ? 0 : 1;
    const bPri = prioritySet?.has(b) ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return (nameMap[a] ?? a).toLowerCase().localeCompare((nameMap[b] ?? b).toLowerCase());
  });

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 rounded-t-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <div className="flex items-center gap-1">
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                aria-label="Refresh list"
              >
                <svg className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-2 pb-8">
          {sorted.length === 0 && (
            <p className="text-zinc-400 text-sm text-center py-6">{emptyMessage ?? 'None available'}</p>
          )}
          {sorted.map((raw) => {
            const name = nameMap[raw] ?? raw;
            const isSelected = raw === selected;
            const badge = badgeMap?.[raw];
            const isMatch = badge !== undefined && prioritySet?.has(raw);
            return (
              <button
                key={raw}
                type="button"
                onClick={() => { onSelect(raw); onClose(); }}
                className={`w-full text-left px-4 py-3 rounded-xl min-h-[64px] flex flex-col justify-center transition-colors
                  ${isSelected
                    ? 'bg-violet-600/20 border border-violet-600/50'
                    : 'bg-zinc-800 border border-transparent hover:bg-zinc-700 active:bg-zinc-600'}`}
              >
                <span className={`font-medium text-sm leading-snug flex items-center gap-1.5 flex-wrap ${isSelected ? 'text-violet-200' : 'text-zinc-100'}`}>
                  {badge && (
                    <span className={`text-xs font-medium px-1.5 py-0 rounded leading-5 flex-shrink-0
                      ${isMatch
                        ? 'bg-violet-700/60 text-violet-200 border border-violet-600/50'
                        : 'bg-zinc-700 text-zinc-400 border border-zinc-600/50'}`}>
                      {badge}
                    </span>
                  )}
                  {name}
                </span>
                {name !== raw && (
                  <span className="text-xs text-zinc-400 mt-0.5 truncate">{raw}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface LoraRowProps {
  weight: number;
  displayName: string;
  triggerPills: string[];
  onOpenPicker: () => void;
  onWeightChange: (w: number) => void;
  onRemove: () => void;
}

function LoraRow({ weight, displayName, triggerPills, onOpenPicker, onWeightChange, onRemove }: LoraRowProps) {
  const [weightStr, setWeightStr] = useState(weight.toFixed(2));
  const inputFocused = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) {
      setWeightStr(weight.toFixed(2));
    }
  }, [weight]);

  return (
    <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
      {/* Top row: name selector + remove */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenPicker}
          className="input-base flex-1 min-w-0 text-left flex items-center justify-between min-h-12 px-3 py-2"
        >
          <span className="text-sm text-zinc-100 truncate">{displayName}</span>
          <ChevronDown />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="min-h-12 min-w-12 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-700 transition-colors flex-shrink-0 flex items-center justify-center"
          aria-label="Remove LoRA"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* Bottom row: slider + weight input */}
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={-3}
          max={3}
          step={0.05}
          value={Math.min(3, Math.max(-3, weight))}
          onChange={(e) => onWeightChange(parseFloat(e.target.value))}
          className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700"
        />
        <input
          type="text"
          inputMode="decimal"
          value={weightStr}
          onFocus={() => { inputFocused.current = true; }}
          onBlur={() => {
            inputFocused.current = false;
            const parsed = parseFloat(weightStr);
            if (!Number.isFinite(parsed)) {
              setWeightStr(weight.toFixed(2));
            } else if (parsed < -3) {
              setWeightStr('-3.00');
              onWeightChange(-3);
            } else if (parsed > 3) {
              setWeightStr('3.00');
              onWeightChange(3);
            } else {
              setWeightStr(parsed.toFixed(2));
              onWeightChange(parsed);
            }
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '' || v === '-' || v === '-.' || /^-?\d*\.?\d*$/.test(v)) {
              setWeightStr(v);
              const parsed = parseFloat(v);
              if (Number.isFinite(parsed) && parsed >= -3 && parsed <= 3) {
                onWeightChange(parsed);
              }
            }
          }}
          className="w-20 flex-shrink-0 text-center text-sm py-1.5 px-1 input-base"
        />
      </div>
      {/* Trigger word pills */}
      {triggerPills.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {triggerPills.map((word, idx) => (
            <span
              key={`${word}-${idx}`}
              className="text-xs bg-zinc-700/50 text-zinc-400 border border-zinc-600/40 rounded-full px-2.5 py-0.5"
            >
              {word}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ModelSelect({ checkpoint, loras, onCheckpointChange, onLorasChange, refreshToken }: Props) {
  const [models, setModels] = useState<ModelInfo>({ checkpoints: [], loras: [], embeddings: [] });
  const [checkpointNames, setCheckpointNames] = useState<Record<string, string>>({});
  const [checkpointBaseModels, setCheckpointBaseModels] = useState<Record<string, string>>({});
  const [loraNames, setLoraNames] = useState<Record<string, string>>({});
  const [loraTriggerWords, setLoraTriggerWords] = useState<Record<string, string>>({});
  const [loraBaseModels, setLoraBaseModels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ckptBrowserOpen, setCkptBrowserOpen] = useState(false);
  // null = closed; number = index of the LoRA slot being picked
  const [loraPickerIndex, setLoraPickerIndex] = useState<number | null>(null);

  const refreshLists = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/models').then((r) => r.json() as Promise<ModelInfo>),
      fetch('/api/checkpoint-config').then((r) => r.json() as Promise<CheckpointConfig[]>).catch(() => []),
      fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>).catch(() => []),
    ])
      .then(([modelsData, ckptConfigs, loraConfigs]) => {
        setModels(modelsData);
        if (!checkpoint && modelsData.checkpoints[0]) onCheckpointChange(modelsData.checkpoints[0]);

        const ckptNameMap: Record<string, string> = {};
        const ckptBaseMap: Record<string, string> = {};
        for (const c of ckptConfigs) {
          if (c.friendlyName) ckptNameMap[c.checkpointName] = c.friendlyName;
          if (c.baseModel) ckptBaseMap[c.checkpointName] = c.baseModel;
        }
        setCheckpointNames(ckptNameMap);
        setCheckpointBaseModels(ckptBaseMap);

        const loraNameMap: Record<string, string> = {};
        const triggerMap: Record<string, string> = {};
        const loraBaseMap: Record<string, string> = {};
        for (const l of loraConfigs) {
          if (l.friendlyName) loraNameMap[l.loraName] = l.friendlyName;
          if (l.triggerWords?.trim()) triggerMap[l.loraName] = l.triggerWords;
          if (l.baseModel?.trim()) loraBaseMap[l.loraName] = l.baseModel;
        }
        setLoraNames(loraNameMap);
        setLoraTriggerWords(triggerMap);
        setLoraBaseModels(loraBaseMap);
      })
      .catch(() => setError('Could not reach ComfyUI'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpoint, onCheckpointChange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshLists(); }, [refreshToken]);

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

  const checkpointDisplayName = checkpoint
    ? (checkpointNames[checkpoint] ?? checkpoint)
    : 'Select checkpoint…';

  // LoRAs whose baseModel matches the selected checkpoint's baseModel
  const activeCheckpointBase = checkpointBaseModels[checkpoint] ?? '';
  const loraPrioritySet = activeCheckpointBase
    ? new Set(models.loras.filter((l) => loraBaseModels[l] === activeCheckpointBase))
    : undefined;

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Checkpoint — touch-friendly button opens Model Browser */}
      <div>
        <label className="label">Checkpoint</label>
        <button
          type="button"
          onClick={() => setCkptBrowserOpen(true)}
          disabled={loading}
          className="input-base text-left flex items-center justify-between min-h-12 w-full px-3 py-3"
        >
          <span className={checkpoint ? 'text-zinc-100 truncate' : 'text-zinc-500'}>
            {loading ? 'Loading…' : checkpointDisplayName}
          </span>
          <ChevronDown />
        </button>
      </div>

      {ckptBrowserOpen && (
        <ModelSheet
          title="Select Checkpoint"
          items={models.checkpoints}
          selected={checkpoint}
          nameMap={checkpointNames}
          onSelect={onCheckpointChange}
          onClose={() => setCkptBrowserOpen(false)}
          emptyMessage="No checkpoints available"
          onRefresh={refreshLists}
          refreshing={loading}
        />
      )}

      {/* LoRA stack */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="label mb-0">LoRAs</label>
          <button
            type="button"
            onClick={addLora}
            disabled={loading || models.loras.length === 0}
            className="text-xs px-3 min-h-12 rounded-lg bg-zinc-700 hover:bg-zinc-600
                       disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 transition-colors"
          >
            + Add LoRA
          </button>
        </div>

        {loras.length === 0 && (
          <p className="text-xs text-zinc-500 italic">No LoRAs — tap Add LoRA to stack one.</p>
        )}

        <div className="space-y-3">
          {loras.map((entry, i) => {
            const entryDisplayName = loraNames[entry.name] ?? entry.name;
            const rawTriggers = loraTriggerWords[entry.name];
            const triggerPills = rawTriggers
              ? rawTriggers.split(',').map((t) => t.trim()).filter(Boolean)
              : [];

            return (
              <LoraRow
                key={i}
                weight={entry.weight}
                displayName={entryDisplayName}
                triggerPills={triggerPills}
                onOpenPicker={() => setLoraPickerIndex(i)}
                onWeightChange={(w) => updateLora(i, 'weight', w)}
                onRemove={() => removeLora(i)}
              />
            );
          })}
        </div>
      </div>

      {/* LoRA picker sheet — shared across all LoRA slots */}
      {loraPickerIndex !== null && (
        <ModelSheet
          title="Select LoRA"
          items={models.loras}
          selected={loras[loraPickerIndex]?.name ?? ''}
          nameMap={loraNames}
          onSelect={(raw) => updateLora(loraPickerIndex, 'name', raw)}
          onClose={() => setLoraPickerIndex(null)}
          emptyMessage="No LoRAs available"
          onRefresh={refreshLists}
          refreshing={loading}
          badgeMap={loraBaseModels}
          prioritySet={loraPrioritySet}
        />
      )}
    </div>
  );
}
