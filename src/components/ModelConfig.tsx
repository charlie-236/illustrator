'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointConfig, EmbeddingConfig, LoraConfig } from '@/types';
import { SAMPLERS, SCHEDULERS, RESOLUTIONS } from '@/types';
import IngestPanel from '@/components/IngestPanel';
import { useModelLists } from '@/lib/useModelLists';
import DeleteConfirmDialog, { type DeleteResourceType } from '@/components/DeleteConfirmDialog';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const CKPT_BLANK = {
  friendlyName: '',
  baseModel: '',
  defaultWidth: null as number | null,
  defaultHeight: null as number | null,
  defaultPositivePrompt: '',
  defaultNegativePrompt: '',
  description: '',
  url: '' as string | null | undefined,
  defaultSteps: null as number | null,
  defaultCfg: null as number | null,
  defaultSampler: null as string | null,
  defaultScheduler: null as string | null,
  defaultHrf: null as boolean | null,
};

const LORA_BLANK = {
  friendlyName: '',
  triggerWords: '',
  baseModel: '',
  description: '',
  url: '' as string | null | undefined,
};

const BASE_MODEL_OPTIONS = ['', 'SD 1.5', 'SDXL', 'Pony', 'Flux.1', 'SD 3', 'Big Love'];

const EMBEDDING_BLANK = {
  friendlyName: '',
  triggerWords: '',
  baseModel: '',
  category: '',
  description: '',
  url: '' as string | null | undefined,
};

function stripExtension(name: string): string {
  return name.replace(/\.(safetensors|pt|bin|ckpt)$/i, '');
}

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
  const [tab, setTab] = useState<'checkpoints' | 'loras' | 'embeddings' | 'add'>('checkpoints');

  const { data: lists, loading: loadingModels, refresh: refreshLists } = useModelLists();
  const {
    checkpoints,
    loras,
    embeddings,
    checkpointNames: ckptNames,
    loraNames,
    embeddingNames,
  } = lists;

  // Sheet open state
  const [ckptBrowserOpen, setCkptBrowserOpen] = useState(false);
  const [loraBrowserOpen, setLoraBrowserOpen] = useState(false);

  // ── Checkpoint form state ──────────────────────────────────────────
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');
  const [ckptConfigId, setCkptConfigId] = useState<string | null>(null);
  const [ckptForm, setCkptForm] = useState({ ...CKPT_BLANK });
  const [loadingCkptConfig, setLoadingCkptConfig] = useState(false);
  const [ckptStatus, setCkptStatus] = useState<SaveStatus>('idle');
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  // ── LoRA form state ────────────────────────────────────────────────
  const [selectedLora, setSelectedLora] = useState('');
  const [loraConfigId, setLoraConfigId] = useState<string | null>(null);
  const [loraForm, setLoraForm] = useState({ ...LORA_BLANK });
  const [loadingLoraConfig, setLoadingLoraConfig] = useState(false);
  const [loraStatus, setLoraStatus] = useState<SaveStatus>('idle');

  // ── Embedding form state ───────────────────────────────────────────
  const [embeddingBrowserOpen, setEmbeddingBrowserOpen] = useState(false);
  const [selectedEmbedding, setSelectedEmbedding] = useState('');
  const [embeddingConfigId, setEmbeddingConfigId] = useState<string | null>(null);
  const [embeddingForm, setEmbeddingForm] = useState({ ...EMBEDDING_BLANK });
  const [loadingEmbeddingConfig, setLoadingEmbeddingConfig] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<SaveStatus>('idle');
  const [copiedEmbedding, setCopiedEmbedding] = useState(false);

  // ── Delete state ───────────────────────────────────────────────────
  const [deletingModel, setDeletingModel] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteType, setPendingDeleteType] = useState<'checkpoint' | 'lora' | 'embedding' | null>(null);

  function clearDeleteError() {
    if (deleteErrorTimerRef.current) clearTimeout(deleteErrorTimerRef.current);
    setDeleteError(null);
  }

  useEffect(() => () => {
    if (deleteErrorTimerRef.current) clearTimeout(deleteErrorTimerRef.current);
  }, []);

  // Auto-pick initial selections when data arrives
  useEffect(() => {
    if (!selectedCheckpoint && checkpoints.length > 0) {
      setSelectedCheckpoint(checkpoints[0]);
    }
  }, [selectedCheckpoint, checkpoints]);

  useEffect(() => {
    if (!selectedLora && loras.length > 0) {
      setSelectedLora(loras[0]);
    }
  }, [selectedLora, loras]);

  useEffect(() => {
    if (!selectedEmbedding && embeddings.length > 0) {
      setSelectedEmbedding(embeddings[0]);
    }
  }, [selectedEmbedding, embeddings]);

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
              defaultSteps: config.defaultSteps ?? null,
              defaultCfg: config.defaultCfg ?? null,
              defaultSampler: config.defaultSampler ?? null,
              defaultScheduler: config.defaultScheduler ?? null,
              defaultHrf: config.defaultHrf ?? null,
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

  // Load embedding config when selection changes
  useEffect(() => {
    if (!selectedEmbedding) return;
    setLoadingEmbeddingConfig(true);
    setEmbeddingStatus('idle');
    clearDeleteError();

    fetch(`/api/embedding-config?name=${encodeURIComponent(selectedEmbedding)}`)
      .then((r) => (r.status === 404 ? null : r.json() as Promise<EmbeddingConfig>))
      .then((config) => {
        setEmbeddingConfigId(config?.id ?? null);
        setEmbeddingForm(config
          ? {
              friendlyName: config.friendlyName,
              triggerWords: config.triggerWords,
              baseModel: config.baseModel,
              category: config.category ?? '',
              description: config.description ?? '',
              url: config.url,
            }
          : { ...EMBEDDING_BLANK });
      })
      .catch(() => { setEmbeddingConfigId(null); setEmbeddingForm({ ...EMBEDDING_BLANK }); })
      .finally(() => setLoadingEmbeddingConfig(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmbedding]);

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
      if (res.ok) { refreshLists(); onSaved?.(); }
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
      if (res.ok) { refreshLists(); onSaved?.(); }
    } catch {
      setLoraStatus('error');
    }
  }

  async function saveEmbedding() {
    if (!selectedEmbedding) return;
    setEmbeddingStatus('saving');
    try {
      const { url: _embUrl, ...embSaveFields } = embeddingForm;
      const res = await fetch('/api/embedding-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeddingName: selectedEmbedding, ...embSaveFields }),
      });
      setEmbeddingStatus(res.ok ? 'saved' : 'error');
      if (res.ok) { refreshLists(); onSaved?.(); }
    } catch {
      setEmbeddingStatus('error');
    }
  }

  function deleteCurrentModel(type: 'checkpoint' | 'lora' | 'embedding') {
    const filename =
      type === 'checkpoint' ? selectedCheckpoint :
      type === 'lora' ? selectedLora :
      selectedEmbedding;
    if (!filename) return;
    setPendingDeleteType(type);
    setShowDeleteDialog(true);
  }

  async function executeDelete() {
    const type = pendingDeleteType;
    if (!type) return;
    setShowDeleteDialog(false);
    setPendingDeleteType(null);

    const filename =
      type === 'checkpoint' ? selectedCheckpoint :
      type === 'lora' ? selectedLora :
      selectedEmbedding;
    if (!filename) return;

    clearDeleteError();
    setDeletingModel(true);
    try {
      const res = await fetch(`/api/models/${type}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        const msg = data.error ?? `Delete failed (${res.status})`;
        setDeleteError(msg);
        deleteErrorTimerRef.current = setTimeout(() => setDeleteError(null), 7000);
        return;
      }

      if (type === 'checkpoint') {
        setSelectedCheckpoint('');
        setCkptConfigId(null);
        setCkptForm({ ...CKPT_BLANK });
      } else if (type === 'lora') {
        setSelectedLora('');
        setLoraConfigId(null);
        setLoraForm({ ...LORA_BLANK });
      } else {
        setSelectedEmbedding('');
        setEmbeddingConfigId(null);
        setEmbeddingForm({ ...EMBEDDING_BLANK });
      }
      refreshLists();
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

  function embeddingField<K extends keyof typeof embeddingForm>(key: K, value: (typeof embeddingForm)[K]) {
    setEmbeddingForm((prev) => ({ ...prev, [key]: value }));
    setEmbeddingStatus('idle');
  }

  return (
    <div className="p-4 space-y-4">
      <div className="card space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-200">Model Settings</h2>
          <button
            type="button"
            onClick={() => refreshLists()}
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
        {(['checkpoints', 'loras', 'embeddings', 'add'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 min-h-12 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            {t === 'checkpoints' ? 'Checkpoints' : t === 'loras' ? 'LoRAs' : t === 'embeddings' ? 'Embeddings' : 'Add Models'}
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

            {/* Default settings collapsible */}
            <div className="border-t border-zinc-800/60 pt-3">
              <button
                type="button"
                onClick={() => setDefaultsOpen((o) => !o)}
                className="w-full flex items-center justify-between min-h-12 px-0 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
              >
                <span>Default generation settings</span>
                <svg
                  className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${defaultsOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <p className="text-xs text-zinc-500 mb-2">
                Soft-fill the Studio form when this checkpoint is selected. Leave blank to leave the form alone.
              </p>

              {defaultsOpen && (
                <div className="space-y-4 pt-1">

                  {/* Resolution */}
                  <div>
                    <label className="label">Default Resolution</label>
                    <select
                      value={RESOLUTIONS.find((r) => r.w === ckptForm.defaultWidth && r.h === ckptForm.defaultHeight)?.label ?? ''}
                      onChange={(e) => {
                        const res = RESOLUTIONS.find((r) => r.label === e.target.value);
                        if (res) {
                          setCkptForm((prev) => ({ ...prev, defaultWidth: res.w, defaultHeight: res.h }));
                        } else {
                          setCkptForm((prev) => ({ ...prev, defaultWidth: null, defaultHeight: null }));
                        }
                        setCkptStatus('idle');
                      }}
                      className="input-base"
                    >
                      <option value="">— No default —</option>
                      {RESOLUTIONS.map((r) => (
                        <option key={r.label} value={r.label}>{r.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Steps + CFG */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Default Steps</label>
                      <input
                        type="number" min={1} max={80} step={1}
                        value={ckptForm.defaultSteps ?? ''}
                        onChange={(e) => ckptField('defaultSteps', e.target.value === '' ? null : parseInt(e.target.value, 10))}
                        placeholder="Not set"
                        className="input-base"
                      />
                    </div>
                    <div>
                      <label className="label">Default CFG</label>
                      <input
                        type="number" min={1} max={20} step={0.1}
                        value={ckptForm.defaultCfg ?? ''}
                        onChange={(e) => ckptField('defaultCfg', e.target.value === '' ? null : parseFloat(e.target.value))}
                        placeholder="Not set"
                        className="input-base"
                      />
                    </div>
                  </div>

                  {/* Sampler */}
                  <div>
                    <label className="label">Default Sampler</label>
                    <select
                      value={ckptForm.defaultSampler ?? ''}
                      onChange={(e) => ckptField('defaultSampler', e.target.value || null)}
                      className="input-base"
                    >
                      <option value="">— No default —</option>
                      {SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  {/* Scheduler */}
                  <div>
                    <label className="label">Default Scheduler</label>
                    <select
                      value={ckptForm.defaultScheduler ?? ''}
                      onChange={(e) => ckptField('defaultScheduler', e.target.value || null)}
                      className="input-base"
                    >
                      <option value="">— No default —</option>
                      {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  {/* Hi-Res Fix — tri-state */}
                  <div>
                    <label className="label">Default Hi-Res Fix</label>
                    <div className="flex rounded-lg overflow-hidden border border-zinc-700">
                      {([false, null, true] as const).map((val) => {
                        const label = val === false ? 'Off' : val === true ? 'On' : 'No default';
                        const isActive = ckptForm.defaultHrf === val;
                        return (
                          <button
                            key={String(val)}
                            type="button"
                            onClick={() => ckptField('defaultHrf', val)}
                            className={`flex-1 min-h-12 text-sm font-medium transition-colors
                              ${isActive
                                ? 'bg-violet-600/30 text-violet-200'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                </div>
              )}
            </div>

            <SaveRow status={ckptStatus} onSave={saveCheckpoint} disabled={!selectedCheckpoint} />

            {selectedCheckpoint && (
              <DeleteRow
                modelName={ckptNames[selectedCheckpoint] || selectedCheckpoint}
                deleting={deletingModel}
                error={deleteError}
                onDelete={() => deleteCurrentModel('checkpoint')}
              />
            )}
          </div>
        </>
      )}

      {/* ── Embeddings tab ──────────────────────────────────────────── */}
      {tab === 'embeddings' && (
        <>
          <div className="card">
            <SelectorButton
              label="Embedding"
              displayName={loadingModels ? '' : (embeddingNames[selectedEmbedding] ?? selectedEmbedding)}
              disabled={loadingModels || embeddings.length === 0}
              onClick={() => setEmbeddingBrowserOpen(true)}
            />
            {!loadingModels && embeddings.length === 0 && (
              <p className="text-xs text-zinc-400 mt-2">No embeddings found on the VM. Use Add Models to ingest one.</p>
            )}
          </div>

          {embeddingBrowserOpen && (
            <ModelSheet
              title="Select Embedding"
              items={embeddings}
              selected={selectedEmbedding}
              nameMap={embeddingNames}
              onSelect={setSelectedEmbedding}
              onClose={() => setEmbeddingBrowserOpen(false)}
              emptyMessage="No embeddings available"
            />
          )}

          {selectedEmbedding && (
            <div className={`card space-y-4 transition-opacity ${loadingEmbeddingConfig ? 'opacity-40 pointer-events-none' : ''}`}>
              <div>
                <label className="label">File</label>
                <input
                  type="text"
                  readOnly
                  value={selectedEmbedding}
                  className="input-base min-h-12 bg-zinc-800/40 text-zinc-400 font-mono text-xs cursor-default"
                />
              </div>

              <div>
                <label className="label">Usage</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 font-mono text-sm select-all">
                    embedding:{stripExtension(selectedEmbedding)}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(`embedding:${stripExtension(selectedEmbedding)}`);
                      setCopiedEmbedding(true);
                      setTimeout(() => setCopiedEmbedding(false), 1500);
                    }}
                    className="min-h-12 min-w-12 flex items-center justify-center rounded-lg border border-zinc-700
                               bg-zinc-800 hover:bg-zinc-700 transition-colors flex-shrink-0"
                    aria-label="Copy usage syntax"
                  >
                    {copiedEmbedding ? (
                      <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
                <p className="text-xs text-zinc-500 mt-1">Paste this into the positive or negative prompt in Studio.</p>
              </div>

              <div>
                <label className="label">Friendly Name</label>
                <input
                  type="text"
                  value={embeddingForm.friendlyName}
                  onChange={(e) => embeddingField('friendlyName', e.target.value)}
                  placeholder="e.g. Fast Negative V2"
                  className="input-base"
                />
              </div>

              <div>
                <label className="label">Category</label>
                <input
                  type="text"
                  value={embeddingForm.category ?? ''}
                  onChange={(e) => embeddingField('category', e.target.value)}
                  placeholder="negative, style, character, concept…"
                  className="input-base min-h-12"
                />
              </div>

              <div>
                <label className="label">Base Model</label>
                <input
                  type="text"
                  value={embeddingForm.baseModel ?? ''}
                  onChange={(e) => embeddingField('baseModel', e.target.value)}
                  placeholder="SD 1.5, SDXL, Pony, etc."
                  className="input-base min-h-12"
                />
              </div>

              <div>
                <label className="label">Trigger Words</label>
                <textarea rows={2}
                  value={embeddingForm.triggerWords}
                  onChange={(e) => embeddingField('triggerWords', e.target.value)}
                  placeholder="Words to use alongside this embedding…"
                  className="input-base resize-none leading-relaxed"
                />
              </div>

              <div>
                <label className="label">Description</label>
                <textarea rows={3}
                  value={embeddingForm.description ?? ''}
                  onChange={(e) => embeddingField('description', e.target.value)}
                  placeholder="Notes about this embedding — purpose, recommended usage…"
                  className="input-base resize-none leading-relaxed"
                />
              </div>

              {embeddingForm.url && (
                <div>
                  <label className="label">URL</label>
                  <a
                    href={embeddingForm.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-400 text-sm break-all hover:text-blue-300 underline underline-offset-2 transition-colors"
                  >
                    {embeddingForm.url}
                  </a>
                </div>
              )}

              <SaveRow status={embeddingStatus} onSave={saveEmbedding} disabled={!selectedEmbedding} />

              <DeleteRow
                modelName={embeddingNames[selectedEmbedding] || selectedEmbedding}
                deleting={deletingModel}
                error={deleteError}
                onDelete={() => deleteCurrentModel('embedding')}
              />
            </div>
          )}
        </>
      )}

      {/* ── Add Models tab ──────────────────────────────────────────── */}
      {tab === 'add' && (
        <IngestPanel onIngestComplete={() => { onSaved?.(); refreshLists(); }} />
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

            {selectedLora && (
              <DeleteRow
                modelName={loraNames[selectedLora] || selectedLora}
                deleting={deletingModel}
                error={deleteError}
                onDelete={() => deleteCurrentModel('lora')}
              />
            )}
          </div>
        </>
      )}

      {/* ── Delete confirm dialog ── */}
      {pendingDeleteType && (() => {
        const filename =
          pendingDeleteType === 'checkpoint' ? selectedCheckpoint :
          pendingDeleteType === 'lora' ? selectedLora :
          selectedEmbedding;
        const nameMap =
          pendingDeleteType === 'checkpoint' ? ckptNames :
          pendingDeleteType === 'lora' ? loraNames :
          embeddingNames;
        const resourceName = nameMap[filename] || filename;
        return (
          <DeleteConfirmDialog
            open={showDeleteDialog}
            resourceType={pendingDeleteType as DeleteResourceType}
            resourceName={resourceName}
            warningMessage="The file will be deleted from the VM and the metadata row from the database. This cannot be undone."
            onConfirm={(_cascade: boolean) => { void executeDelete(); }}
            onCancel={() => { setShowDeleteDialog(false); setPendingDeleteType(null); }}
          />
        );
      })()}
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
  modelName: string;
  deleting: boolean;
  error: string | null;
  onDelete: () => void;
}

function DeleteRow({ modelName, deleting, error, onDelete }: DeleteRowProps) {
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
