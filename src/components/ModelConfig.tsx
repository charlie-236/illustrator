'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointConfig, LoraConfig, ModelInfo } from '@/types';
import IngestPanel from '@/components/IngestPanel';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const CKPT_BLANK = {
  friendlyName: '',
  baseModel: '',
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultPositivePrompt: '',
  defaultNegativePrompt: '',
  description: '',
  url: '' as string | null | undefined,
};

const LORA_BLANK = {
  friendlyName: '',
  triggerWords: '',
  baseModel: '',
  description: '',
  url: '' as string | null | undefined,
};

const BASE_MODEL_OPTIONS = ['', 'SD 1.5', 'SDXL', 'Pony', 'Flux.1', 'SD 3', 'Big Love'];

// ── Shared bottom-sheet picker ────────────────────────────────────────────────

interface SheetProps {
  title: string;
  items: string[];
  selected: string;
  nameMap: Record<string, string>;
  onSelect: (value: string) => void;
  onClose: () => void;
  emptyMessage?: string;
}

function ModelSheet({ title, items, selected, nameMap, onSelect, onClose, emptyMessage }: SheetProps) {
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
          {items.length === 0 && (
            <p className="text-zinc-400 text-sm text-center py-6">{emptyMessage ?? 'None available'}</p>
          )}
          {[...items].sort((a, b) => (nameMap[a] ?? a).toLowerCase().localeCompare((nameMap[b] ?? b).toLowerCase())).map((raw) => {
            const name = nameMap[raw] ?? raw;
            const isSelected = raw === selected;
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
                <span className={`font-medium text-sm leading-snug ${isSelected ? 'text-violet-200' : 'text-zinc-100'}`}>
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

// ── Selector button (the trigger that opens a sheet) ──────────────────────────

interface SelectorButtonProps {
  label: string;
  displayName: string;
  disabled: boolean;
  onClick: () => void;
}

function SelectorButton({ label, displayName, disabled, onClick }: SelectorButtonProps) {
  return (
    <div>
      <label className="label">{label}</label>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="input-base text-left flex items-center justify-between min-h-12 w-full px-3 py-3"
      >
        <span className={displayName ? 'text-zinc-100 truncate' : 'text-zinc-500'}>
          {displayName || 'Loading…'}
        </span>
        <svg className="w-4 h-4 text-zinc-500 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ModelConfig({ onSaved }: { onSaved?: () => void }) {
  const [tab, setTab] = useState<'checkpoints' | 'loras' | 'add'>('checkpoints');

  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [loras, setLoras] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // Friendly-name maps populated from the config APIs
  const [ckptNames, setCkptNames] = useState<Record<string, string>>({});
  const [loraNames, setLoraNames] = useState<Record<string, string>>({});

  // Sheet open state
  const [ckptBrowserOpen, setCkptBrowserOpen] = useState(false);
  const [loraBrowserOpen, setLoraBrowserOpen] = useState(false);

  // ── Checkpoint form state ──────────────────────────────────────────
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');
  const [ckptConfigId, setCkptConfigId] = useState<string | null>(null);
  const [ckptForm, setCkptForm] = useState({ ...CKPT_BLANK });
  const [loadingCkptConfig, setLoadingCkptConfig] = useState(false);
  const [ckptStatus, setCkptStatus] = useState<SaveStatus>('idle');

  // ── LoRA form state ────────────────────────────────────────────────
  const [selectedLora, setSelectedLora] = useState('');
  const [loraConfigId, setLoraConfigId] = useState<string | null>(null);
  const [loraForm, setLoraForm] = useState({ ...LORA_BLANK });
  const [loadingLoraConfig, setLoadingLoraConfig] = useState(false);
  const [loraStatus, setLoraStatus] = useState<SaveStatus>('idle');

  // ── Delete state ───────────────────────────────────────────────────
  const [deletingModel, setDeletingModel] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearDeleteError() {
    if (deleteErrorTimerRef.current) clearTimeout(deleteErrorTimerRef.current);
    setDeleteError(null);
  }

  useEffect(() => () => {
    if (deleteErrorTimerRef.current) clearTimeout(deleteErrorTimerRef.current);
  }, []);

  const refreshModelLists = useCallback(() => {
    setLoadingModels(true);
    Promise.all([
      fetch('/api/models').then((r) => r.json() as Promise<ModelInfo>),
      fetch('/api/checkpoint-config').then((r) => r.json() as Promise<CheckpointConfig[]>).catch(() => []),
      fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>).catch(() => []),
    ])
      .then(([modelData, ckptConfigs, loraConfigs]) => {
        setCheckpoints(modelData.checkpoints);
        setLoras(modelData.loras);
        setSelectedCheckpoint((prev) => prev || modelData.checkpoints[0] || '');
        setSelectedLora((prev) => prev || modelData.loras[0] || '');

        const ckptMap: Record<string, string> = {};
        for (const c of ckptConfigs) {
          if (c.friendlyName) ckptMap[c.checkpointName] = c.friendlyName;
        }
        setCkptNames(ckptMap);

        const loraMap: Record<string, string> = {};
        for (const l of loraConfigs) {
          if (l.friendlyName) loraMap[l.loraName] = l.friendlyName;
        }
        setLoraNames(loraMap);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshModelLists(); }, []);

  // Reload friendly-name maps after a save so the selector button updates immediately
  function refreshNames() {
    Promise.all([
      fetch('/api/checkpoint-config').then((r) => r.json() as Promise<CheckpointConfig[]>).catch(() => []),
      fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>).catch(() => []),
    ]).then(([ckptConfigs, loraConfigs]) => {
      const ckptMap: Record<string, string> = {};
      for (const c of ckptConfigs) {
        if (c.friendlyName) ckptMap[c.checkpointName] = c.friendlyName;
      }
      setCkptNames(ckptMap);

      const loraMap: Record<string, string> = {};
      for (const l of loraConfigs) {
        if (l.friendlyName) loraMap[l.loraName] = l.friendlyName;
      }
      setLoraNames(loraMap);
    });
  }

  // Load checkpoint config when selection changes
  useEffect(() => {
    if (!selectedCheckpoint) return;
    setLoadingCkptConfig(true);
    setCkptStatus('idle');
    clearDeleteError();

    fetch(`/api/checkpoint-config?name=${encodeURIComponent(selectedCheckpoint)}`)
      .then((r) => (r.status === 404 ? null : r.json() as Promise<CheckpointConfig>))
      .then((config) => {
        setCkptConfigId(config?.id ?? null);
        setCkptForm(config
          ? {
              friendlyName: config.friendlyName,
              baseModel: config.baseModel ?? '',
              defaultWidth: config.defaultWidth,
              defaultHeight: config.defaultHeight,
              defaultPositivePrompt: config.defaultPositivePrompt,
              defaultNegativePrompt: config.defaultNegativePrompt,
              description: config.description ?? '',
              url: config.url,
            }
          : { ...CKPT_BLANK });
      })
      .catch(() => { setCkptConfigId(null); setCkptForm({ ...CKPT_BLANK }); })
      .finally(() => setLoadingCkptConfig(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCheckpoint]);

  // Load LoRA config when selection changes
  useEffect(() => {
    if (!selectedLora) return;
    setLoadingLoraConfig(true);
    setLoraStatus('idle');
    clearDeleteError();

    fetch(`/api/lora-config?name=${encodeURIComponent(selectedLora)}`)
      .then((r) => (r.status === 404 ? null : r.json() as Promise<LoraConfig>))
      .then((config) => {
        setLoraConfigId(config?.id ?? null);
        setLoraForm(config
          ? {
              friendlyName: config.friendlyName,
              triggerWords: config.triggerWords,
              baseModel: config.baseModel,
              description: config.description ?? '',
              url: config.url,
            }
          : { ...LORA_BLANK });
      })
      .catch(() => { setLoraConfigId(null); setLoraForm({ ...LORA_BLANK }); })
      .finally(() => setLoadingLoraConfig(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLora]);

  async function saveCheckpoint() {
    if (!selectedCheckpoint) return;
    setCkptStatus('saving');
    try {
      const { url: _ckptUrl, ...ckptSaveFields } = ckptForm;
      const res = await fetch('/api/checkpoint-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointName: selectedCheckpoint, ...ckptSaveFields }),
      });
      setCkptStatus(res.ok ? 'saved' : 'error');
      if (res.ok) { refreshNames(); onSaved?.(); }
    } catch {
      setCkptStatus('error');
    }
  }

  async function saveLora() {
    if (!selectedLora) return;
    setLoraStatus('saving');
    try {
      const { url: _loraUrl, ...loraSaveFields } = loraForm;
      const res = await fetch('/api/lora-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loraName: selectedLora, ...loraSaveFields }),
      });
      setLoraStatus(res.ok ? 'saved' : 'error');
      if (res.ok) { refreshNames(); onSaved?.(); }
    } catch {
      setLoraStatus('error');
    }
  }

  async function deleteCurrentModel(type: 'checkpoint' | 'lora') {
    const configId = type === 'checkpoint' ? ckptConfigId : loraConfigId;
    if (!configId) return;

    const rawName = type === 'checkpoint' ? selectedCheckpoint : selectedLora;
    const friendlyName = type === 'checkpoint'
      ? (ckptNames[rawName] || rawName)
      : (loraNames[rawName] || rawName);

    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${friendlyName}"?\n\nThis will remove the file from the server and cannot be undone.`,
    );
    if (!confirmed) return;

    clearDeleteError();
    setDeletingModel(true);
    try {
      const res = await fetch(`/api/models/${configId}`, { method: 'DELETE' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        const msg = data.error ?? `Delete failed (${res.status})`;
        setDeleteError(msg);
        deleteErrorTimerRef.current = setTimeout(() => setDeleteError(null), 7000);
        return;
      }

      // Remove from local list immediately for instant feedback
      if (type === 'checkpoint') {
        setCheckpoints((prev) => prev.filter((c) => c !== selectedCheckpoint));
        setCkptNames((prev) => { const n = { ...prev }; delete n[selectedCheckpoint]; return n; });
        setSelectedCheckpoint('');
        setCkptConfigId(null);
        setCkptForm({ ...CKPT_BLANK });
      } else {
        setLoras((prev) => prev.filter((l) => l !== selectedLora));
        setLoraNames((prev) => { const n = { ...prev }; delete n[selectedLora]; return n; });
        setSelectedLora('');
        setLoraConfigId(null);
        setLoraForm({ ...LORA_BLANK });
      }
      // Re-sync with ComfyUI so the list is accurate
      refreshModelLists();
      onSaved?.();
    } catch (err) {
      const msg = `Network error: ${String(err)}`;
      setDeleteError(msg);
      deleteErrorTimerRef.current = setTimeout(() => setDeleteError(null), 7000);
    } finally {
      setDeletingModel(false);
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
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-200">Model Settings</h2>
          <button
            type="button"
            onClick={refreshModelLists}
            disabled={loadingModels}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40"
            aria-label="Refresh model lists"
          >
            <svg className={`w-5 h-5 ${loadingModels ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
        <p className="text-xs text-zinc-400">
          Assign friendly names, trigger words, and defaults to your models.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-zinc-800/60 rounded-xl">
        {(['checkpoints', 'loras', 'add'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 min-h-12 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            {t === 'checkpoints' ? 'Checkpoints' : t === 'loras' ? 'LoRAs' : 'Add Models'}
          </button>
        ))}
      </div>

      {/* ── Checkpoints tab ─────────────────────────────────────────── */}
      {tab === 'checkpoints' && (
        <>
          <div className="card">
            <SelectorButton
              label="Checkpoint"
              displayName={loadingModels ? '' : (ckptNames[selectedCheckpoint] ?? selectedCheckpoint)}
              disabled={loadingModels}
              onClick={() => setCkptBrowserOpen(true)}
            />
          </div>

          {ckptBrowserOpen && (
            <ModelSheet
              title="Select Checkpoint"
              items={checkpoints}
              selected={selectedCheckpoint}
              nameMap={ckptNames}
              onSelect={setSelectedCheckpoint}
              onClose={() => setCkptBrowserOpen(false)}
              emptyMessage="No checkpoints available"
            />
          )}

          <div className={`card space-y-4 transition-opacity ${loadingCkptConfig ? 'opacity-40 pointer-events-none' : ''}`}>
            <div>
              <label className="label">File</label>
              <input
                type="text"
                readOnly
                value={selectedCheckpoint}
                className="input-base min-h-12 bg-zinc-800/40 text-zinc-400 font-mono text-xs cursor-default"
              />
            </div>

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

            <div>
              <label className="label">Base Model</label>
              <input
                type="text"
                value={ckptForm.baseModel ?? ''}
                onChange={(e) => ckptField('baseModel', e.target.value)}
                placeholder="Pony, SDXL 1.0, Illustrious, etc."
                className="input-base min-h-12"
              />
              <p className="text-xs text-zinc-500 mt-1">
                Used to match compatible LoRAs and to flag stylized checkpoints in the Reference panel.
              </p>
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
              <p className="text-xs text-zinc-400 mb-1.5">
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

            <div>
              <label className="label">Description</label>
              <textarea rows={3}
                value={ckptForm.description ?? ''}
                onChange={(e) => ckptField('description', e.target.value)}
                placeholder="Notes about this checkpoint — architecture, training data, use cases…"
                className="input-base resize-none leading-relaxed"
              />
            </div>

            {ckptForm.url && (
              <div>
                <label className="label">URL</label>
                <a
                  href={ckptForm.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-blue-400 text-sm break-all hover:text-blue-300 underline underline-offset-2 transition-colors"
                >
                  {ckptForm.url}
                </a>
              </div>
            )}

            <SaveRow status={ckptStatus} onSave={saveCheckpoint} disabled={!selectedCheckpoint} />

            <DeleteRow
              configId={ckptConfigId}
              modelName={ckptNames[selectedCheckpoint] || selectedCheckpoint}
              deleting={deletingModel}
              error={deleteError}
              onDelete={() => deleteCurrentModel('checkpoint')}
            />
          </div>
        </>
      )}

      {/* ── Add Models tab ──────────────────────────────────────────── */}
      {tab === 'add' && (
        <IngestPanel onIngestComplete={() => { onSaved?.(); refreshModelLists(); }} />
      )}

      {/* ── LoRAs tab ────────────────────────────────────────────────── */}
      {tab === 'loras' && (
        <>
          <div className="card">
            <SelectorButton
              label="LoRA"
              displayName={loadingModels ? '' : (loraNames[selectedLora] ?? selectedLora)}
              disabled={loadingModels || loras.length === 0}
              onClick={() => setLoraBrowserOpen(true)}
            />
            {!loadingModels && loras.length === 0 && (
              <p className="text-xs text-zinc-400 mt-2">No LoRAs found in ComfyUI.</p>
            )}
          </div>

          {loraBrowserOpen && (
            <ModelSheet
              title="Select LoRA"
              items={loras}
              selected={selectedLora}
              nameMap={loraNames}
              onSelect={setSelectedLora}
              onClose={() => setLoraBrowserOpen(false)}
              emptyMessage="No LoRAs available"
            />
          )}

          <div className={`card space-y-4 transition-opacity ${loadingLoraConfig ? 'opacity-40 pointer-events-none' : ''}`}>
            <div>
              <label className="label">File</label>
              <input
                type="text"
                readOnly
                value={selectedLora}
                className="input-base min-h-12 bg-zinc-800/40 text-zinc-400 font-mono text-xs cursor-default"
              />
            </div>

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
              <p className="text-xs text-zinc-400 mb-1.5">
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

            <div>
              <label className="label">Description</label>
              <textarea rows={3}
                value={loraForm.description ?? ''}
                onChange={(e) => loraField('description', e.target.value)}
                placeholder="Notes about this LoRA — style, subject, recommended weight…"
                className="input-base resize-none leading-relaxed"
              />
            </div>

            {loraForm.url && (
              <div>
                <label className="label">URL</label>
                <a
                  href={loraForm.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-blue-400 text-sm break-all hover:text-blue-300 underline underline-offset-2 transition-colors"
                >
                  {loraForm.url}
                </a>
              </div>
            )}

            <SaveRow status={loraStatus} onSave={saveLora} disabled={!selectedLora} />

            <DeleteRow
              configId={loraConfigId}
              modelName={loraNames[selectedLora] || selectedLora}
              deleting={deletingModel}
              error={deleteError}
              onDelete={() => deleteCurrentModel('lora')}
            />
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
        className="flex-1 min-h-12 rounded-xl font-semibold text-sm transition-all
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

interface DeleteRowProps {
  configId: string | null;
  modelName: string;
  deleting: boolean;
  error: string | null;
  onDelete: () => void;
}

function DeleteRow({ configId, modelName, deleting, error, onDelete }: DeleteRowProps) {
  if (!configId) return null;
  return (
    <div className="pt-2 border-t border-zinc-800/60 space-y-2">
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="w-full min-h-12 rounded-xl font-semibold text-sm transition-all
                   bg-red-950/40 hover:bg-red-900/50 active:scale-[0.98]
                   border border-red-800/50 hover:border-red-700
                   text-red-300 hover:text-red-200
                   disabled:opacity-50 disabled:cursor-not-allowed
                   flex items-center justify-center gap-2"
      >
        {deleting ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Deleting…
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete {modelName && `"${modelName}"`}
          </>
        )}
      </button>
      {error && (
        <p className="text-xs text-red-400 text-center leading-snug">{error}</p>
      )}
    </div>
  );
}
