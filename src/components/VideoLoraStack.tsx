'use client';

import { useEffect, useRef, useState } from 'react';
import type { WanLoraEntry } from '@/types';
import type { ModelLists } from '@/lib/useModelLists';

/** Canonical base model string for Wan 2.2 LoRAs. Must match registerModel.ts normalizeBaseModel(). */
const WAN_BASE_MODEL = 'Wan 2.2';

interface Props {
  loras: WanLoraEntry[];
  lists: ModelLists;
  onChange: (loras: WanLoraEntry[]) => void;
}

function ChevronDown() {
  return (
    <svg className="w-4 h-4 text-zinc-500 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

interface PickerSheetProps {
  wanLoras: string[];
  lists: ModelLists;
  selected: string;
  onSelect: (loraName: string) => void;
  onClose: () => void;
}

function LoraPickerSheet({ wanLoras, lists, selected, onSelect, onClose }: PickerSheetProps) {
  const sorted = [...wanLoras].sort((a, b) =>
    (lists.loraNames[a] ?? a).toLowerCase().localeCompare((lists.loraNames[b] ?? b).toLowerCase()),
  );

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
          <h2 className="text-base font-semibold text-zinc-100">Select Wan LoRA</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-2 pb-8">
          {sorted.length === 0 && (
            <p className="text-zinc-400 text-sm text-center py-6">No Wan 2.2 LoRAs available. Ingest one via the Models tab.</p>
          )}
          {sorted.map((loraName) => {
            const displayName = lists.loraNames[loraName] ?? loraName;
            const isSelected = loraName === selected;
            return (
              <button
                key={loraName}
                type="button"
                onClick={() => { onSelect(loraName); onClose(); }}
                className={`w-full text-left px-4 py-3 rounded-xl min-h-[64px] flex flex-col justify-center transition-colors
                  ${isSelected
                    ? 'bg-violet-600/20 border border-violet-600/50'
                    : 'bg-zinc-800 border border-transparent hover:bg-zinc-700 active:bg-zinc-600'}`}
              >
                <span className={`font-medium text-sm leading-snug ${isSelected ? 'text-violet-200' : 'text-zinc-100'}`}>
                  {displayName}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  entry: WanLoraEntry;
  displayName: string;
  onOpenPicker: () => void;
  onWeightChange: (w: number) => void;
  onRemove: () => void;
}

function VideoLoraRow({ entry, displayName, onOpenPicker, onWeightChange, onRemove }: RowProps) {
  const [weightStr, setWeightStr] = useState(entry.weight.toFixed(2));
  const inputFocused = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) {
      setWeightStr(entry.weight.toFixed(2));
    }
  }, [entry.weight]);

  return (
    <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
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
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={Math.min(2, Math.max(0, entry.weight))}
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
              setWeightStr(entry.weight.toFixed(2));
            } else {
              const clamped = Math.min(2, Math.max(0, parsed));
              setWeightStr(clamped.toFixed(2));
              onWeightChange(clamped);
            }
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '' || /^\d*\.?\d*$/.test(v)) {
              setWeightStr(v);
              const parsed = parseFloat(v);
              if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
                onWeightChange(parsed);
              }
            }
          }}
          className="w-20 flex-shrink-0 text-center text-sm py-1.5 px-1 input-base"
        />
      </div>
    </div>
  );
}

export default function VideoLoraStack({ loras, lists, onChange }: Props) {
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  const wanLoras = lists.loras.filter((l) => lists.loraBaseModels[l] === WAN_BASE_MODEL);

  function addLora() {
    if (wanLoras.length === 0) return;
    onChange([...loras, { loraName: wanLoras[0], weight: 1.0 }]);
  }

  function updateWeight(index: number, weight: number) {
    onChange(loras.map((e, i) => (i === index ? { ...e, weight } : e)));
  }

  function updateName(index: number, loraName: string) {
    onChange(loras.map((e, i) => (i === index ? { ...e, loraName } : e)));
  }

  function remove(index: number) {
    onChange(loras.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="label mb-0">Video LoRAs</label>
        <button
          type="button"
          onClick={addLora}
          disabled={wanLoras.length === 0}
          className="text-xs px-3 min-h-12 rounded-lg bg-zinc-700 hover:bg-zinc-600
                     disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 transition-colors"
        >
          + Add LoRA
        </button>
      </div>

      {loras.length === 0 ? (
        <p className="text-xs text-zinc-500 italic">No LoRAs selected. Add one to refine output.</p>
      ) : (
        <div className="space-y-3">
          {loras.map((entry, i) => (
            <VideoLoraRow
              key={i}
              entry={entry}
              displayName={lists.loraNames[entry.loraName] ?? entry.loraName}
              onOpenPicker={() => setPickerIndex(i)}
              onWeightChange={(w) => updateWeight(i, w)}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}

      {pickerIndex !== null && (
        <LoraPickerSheet
          wanLoras={wanLoras}
          lists={lists}
          selected={loras[pickerIndex]?.loraName ?? ''}
          onSelect={(name) => updateName(pickerIndex, name)}
          onClose={() => setPickerIndex(null)}
        />
      )}
    </div>
  );
}
