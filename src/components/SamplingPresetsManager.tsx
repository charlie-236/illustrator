'use client';

import React, { useState, useEffect } from 'react';
import type { SamplingPresetRecord, SamplingParams } from '@/types';

interface Props {
  onClose: () => void;
  onPresetSaved?: () => void;
}

const PARAM_DEFAULTS: SamplingParams = {
  temperature: 1.1,
  min_p: 0.05,
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 2,
  max_tokens: 1500,
};

function paramsLabel(p: SamplingParams): string {
  const parts: string[] = [];
  if (p.temperature !== undefined) parts.push(`temp ${p.temperature}`);
  if (p.min_p !== undefined) parts.push(`min_p ${p.min_p}`);
  if (p.dry_multiplier !== undefined && p.dry_multiplier > 0) parts.push('DRY on');
  if (p.max_tokens !== undefined) parts.push(`max ${p.max_tokens}`);
  return parts.join(' · ');
}

interface EditState {
  name: string;
  temperature: string;
  min_p: string;
  dry_multiplier: string;
  dry_base: string;
  dry_allowed_length: string;
  max_tokens: string;
}

function presetToEditState(preset: SamplingPresetRecord | null): EditState {
  const p = preset?.paramsJson ?? PARAM_DEFAULTS;
  return {
    name: preset?.name ?? '',
    temperature: String(p.temperature ?? 1.1),
    min_p: String(p.min_p ?? 0.05),
    dry_multiplier: String(p.dry_multiplier ?? 0.8),
    dry_base: String(p.dry_base ?? 1.75),
    dry_allowed_length: String(p.dry_allowed_length ?? 2),
    max_tokens: String(p.max_tokens ?? 1500),
  };
}

function editStateToParams(state: EditState): SamplingParams {
  return {
    temperature: parseFloat(state.temperature),
    min_p: parseFloat(state.min_p),
    dry_multiplier: parseFloat(state.dry_multiplier),
    dry_base: parseFloat(state.dry_base),
    dry_allowed_length: parseInt(state.dry_allowed_length, 10),
    max_tokens: parseInt(state.max_tokens, 10),
  };
}

export default function SamplingPresetsManager({ onClose, onPresetSaved }: Props) {
  const [presets, setPresets] = useState<SamplingPresetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SamplingPresetRecord | null | 'new'>(null);
  const [editState, setEditState] = useState<EditState>(presetToEditState(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/sampling-presets')
      .then((r) => r.json())
      .then((d: { presets: SamplingPresetRecord[] }) => {
        setPresets(d.presets);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function startEdit(preset: SamplingPresetRecord) {
    setEditing(preset);
    setEditState(presetToEditState(preset));
    setError(null);
  }

  function startNew() {
    setEditing('new');
    setEditState(presetToEditState(null));
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const paramsJson = editStateToParams(editState);
      if (editing === 'new') {
        const res = await fetch('/api/sampling-presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: editState.name, paramsJson }),
        });
        const data = (await res.json()) as { preset?: SamplingPresetRecord; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Failed to save');
        setPresets((prev) => [...prev, data.preset!]);
      } else if (editing) {
        const res = await fetch(`/api/sampling-presets/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: editState.name, paramsJson }),
        });
        const data = (await res.json()) as { preset?: SamplingPresetRecord; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Failed to save');
        setPresets((prev) => prev.map((p) => (p.id === editing.id ? data.preset! : p)));
      }
      setEditing(null);
      onPresetSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(preset: SamplingPresetRecord) {
    if (!confirm(`Delete preset "${preset.name}"?`)) return;
    try {
      const res = await fetch(`/api/sampling-presets/${preset.id}`, { method: 'DELETE' });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete');
      setPresets((prev) => prev.filter((p) => p.id !== preset.id));
      onPresetSaved?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-end">
      <div
        className="w-full bg-zinc-900 border-t border-zinc-800 rounded-t-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">Sampling Presets</h2>
          {editing ? (
            <button
              onClick={() => setEditing(null)}
              className="text-zinc-400 hover:text-zinc-200 text-sm min-h-10 px-3"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200 min-h-10 min-w-10 flex items-center justify-center"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {editing ? (
            /* Edit / New preset form */
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-zinc-300">
                {editing === 'new' ? 'New Preset' : `Edit "${editing.name}"`}
              </h3>

              <div>
                <label className="label mb-1.5">Name</label>
                <input
                  className="input-base"
                  value={editState.name}
                  onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
                  placeholder="My preset"
                  maxLength={60}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label mb-1.5">Temperature</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="2"
                    className="input-base"
                    value={editState.temperature}
                    onChange={(e) => setEditState((s) => ({ ...s, temperature: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label mb-1.5">min_p</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    className="input-base"
                    value={editState.min_p}
                    onChange={(e) => setEditState((s) => ({ ...s, min_p: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label mb-1.5">DRY multiplier</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    className="input-base"
                    value={editState.dry_multiplier}
                    onChange={(e) => setEditState((s) => ({ ...s, dry_multiplier: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label mb-1.5">DRY base</label>
                  <input
                    type="number"
                    step="0.05"
                    min="1"
                    max="3"
                    className="input-base"
                    value={editState.dry_base}
                    onChange={(e) => setEditState((s) => ({ ...s, dry_base: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label mb-1.5">DRY allowed length</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    className="input-base"
                    value={editState.dry_allowed_length}
                    onChange={(e) =>
                      setEditState((s) => ({ ...s, dry_allowed_length: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="label mb-1.5">Max tokens</label>
                  <input
                    type="number"
                    min="100"
                    max="8000"
                    className="input-base"
                    value={editState.max_tokens}
                    onChange={(e) => setEditState((s) => ({ ...s, max_tokens: e.target.value }))}
                  />
                </div>
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                onClick={handleSave}
                disabled={saving || !editState.name.trim()}
                className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-xl min-h-12 transition-colors"
              >
                {saving ? 'Saving…' : 'Save Preset'}
              </button>
            </div>
          ) : (
            /* Preset list */
            <div className="space-y-2">
              {loading && (
                <p className="text-zinc-500 text-sm text-center py-4">Loading…</p>
              )}

              {!loading && presets.length === 0 && (
                <p className="text-zinc-500 text-sm text-center py-4">No presets yet.</p>
              )}

              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="bg-zinc-800 rounded-xl px-4 py-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{preset.name}</span>
                      {preset.isBuiltIn && (
                        <span className="text-xs text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">
                          built-in
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5">{paramsLabel(preset.paramsJson)}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(preset)}
                      className="text-zinc-400 hover:text-zinc-200 text-sm min-h-10 px-3"
                    >
                      Edit
                    </button>
                    {!preset.isBuiltIn && (
                      <button
                        onClick={() => handleDelete(preset)}
                        className="text-red-400 hover:text-red-300 text-sm min-h-10 px-3"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <button
                onClick={startNew}
                className="w-full border border-dashed border-zinc-700 hover:border-violet-500 text-zinc-400 hover:text-violet-400 rounded-xl min-h-12 text-sm transition-colors"
              >
                + New preset
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
