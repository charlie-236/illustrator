'use client';

import { useState, useEffect } from 'react';
import type { StoryboardScene, Storyboard } from '@/types';

interface Props {
  /** null = create/insert mode; non-null = edit existing scene */
  scene: StoryboardScene | null;
  /** Required when scene is null (insert mode) — 0-indexed insertion position */
  insertAtPosition?: number;
  sceneIndex: number;
  totalScenes: number;
  storyboard: Storyboard;
  onClose: () => void;
  onSaved: (updated: Storyboard) => void;
}

export default function SceneEditModal({
  scene,
  insertAtPosition,
  sceneIndex,
  totalScenes,
  storyboard,
  onClose,
  onSaved,
}: Props) {
  const isInsert = scene === null;

  const [description, setDescription] = useState(scene?.description ?? '');
  const [positivePrompt, setPositivePrompt] = useState(scene?.positivePrompt ?? '');
  const [durationSeconds, setDurationSeconds] = useState(scene?.durationSeconds ?? 4);
  const [notes, setNotes] = useState(scene?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const isDirty = isInsert
    ? description.trim().length > 0 || positivePrompt.trim().length > 0
    : (description !== scene.description ||
       positivePrompt !== scene.positivePrompt ||
       durationSeconds !== scene.durationSeconds ||
       notes !== (scene.notes ?? ''));

  const descTrimmed = description.trim();
  const promptTrimmed = positivePrompt.trim();
  const descValid = descTrimmed.length >= 1 && descTrimmed.length <= 2000;
  const promptValid = promptTrimmed.length >= 1 && promptTrimmed.length <= 3000;
  const durationValid = Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 10;
  const notesValid = notes.length <= 2000;
  const canSave = descValid && promptValid && durationValid && notesValid;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isDirty) setShowDiscardConfirm(true);
        else onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isDirty, onClose]);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    let updatedScenes: StoryboardScene[];

    if (isInsert) {
      const pos = insertAtPosition ?? storyboard.scenes.length;
      const newScene: StoryboardScene = {
        id: crypto.randomUUID(),
        position: pos,
        description: descTrimmed,
        positivePrompt: promptTrimmed,
        durationSeconds,
        notes: notes.trim() || null,
        canonicalClipId: null,
      };
      updatedScenes = [
        ...storyboard.scenes.slice(0, pos),
        newScene,
        ...storyboard.scenes.slice(pos),
      ].map((s, idx) => ({ ...s, position: idx }));
    } else {
      updatedScenes = storyboard.scenes.map((s) =>
        s.id === scene.id
          ? { ...s, description: descTrimmed, positivePrompt: promptTrimmed, durationSeconds, notes: notes.trim() || null }
          : s,
      );
    }

    const updatedStoryboard: Storyboard = { ...storyboard, scenes: updatedScenes };

    try {
      const res = await fetch(`/api/storyboards/${storyboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updatedStoryboard }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Save failed');
        return;
      }
      onSaved(updatedStoryboard);
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isDirty) setShowDiscardConfirm(true);
    else onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              {isInsert ? 'Insert scene' : `Edit Scene ${sceneIndex + 1}`}
            </h2>
            <p className="text-xs text-zinc-500">
              {isInsert
                ? `Inserting at position ${(insertAtPosition ?? totalScenes) + 1} of ${totalScenes + 1}`
                : `of ${totalScenes} scenes`}
            </p>
          </div>
          <button
            onClick={handleCancel}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Description */}
          <div>
            <label className="label block mb-1">
              Description
              <span className="text-red-400 ml-1">*</span>
            </label>
            <textarea
              className="input-base resize-none"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Scene narrative summary…"
              maxLength={2000}
            />
            {description.trim().length === 0 && (
              <p className="text-xs text-red-400 mt-1">Description is required</p>
            )}
          </div>

          {/* Prompt */}
          <div>
            <label className="label block mb-1">
              Prompt
              <span className="text-red-400 ml-1">*</span>
            </label>
            <textarea
              className="input-base resize-none font-mono text-xs"
              rows={7}
              value={positivePrompt}
              onChange={(e) => setPositivePrompt(e.target.value)}
              placeholder="Wan 2.2 generation prompt…"
              maxLength={3000}
            />
            {positivePrompt.trim().length === 0 && (
              <p className="text-xs text-red-400 mt-1">Prompt is required</p>
            )}
          </div>

          {/* Duration stepper */}
          <div>
            <label className="label block mb-2">Duration (seconds)</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDurationSeconds((d) => Math.max(1, d - 1))}
                disabled={durationSeconds <= 1}
                className="min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-lg font-bold transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                −
              </button>
              <span className="text-lg font-semibold text-zinc-100 tabular-nums w-8 text-center">
                {durationSeconds}
              </span>
              <button
                type="button"
                onClick={() => setDurationSeconds((d) => Math.min(10, d + 1))}
                disabled={durationSeconds >= 10}
                className="min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-lg font-bold transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                +
              </button>
              <span className="text-sm text-zinc-500">
                ≈ {Math.round(durationSeconds * 16 / 8) * 8 + 1} frames at 16 fps
              </span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="label block mb-1">Notes</label>
            <textarea
              className="input-base resize-none"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional freeform notes about this scene…"
              maxLength={2000}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={handleCancel}
              className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave || saving}
              className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {saving ? 'Saving…' : isInsert ? 'Insert scene' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Discard confirm */}
      {showDiscardConfirm && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/60 z-60"
          onClick={() => setShowDiscardConfirm(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 max-w-sm w-full mx-4 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-zinc-100">Discard changes?</h3>
            <p className="text-sm text-zinc-400">Your edits to this scene will be lost.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDiscardConfirm(false)}
                className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Keep editing
              </button>
              <button
                onClick={() => { setShowDiscardConfirm(false); onClose(); }}
                className="flex-1 min-h-12 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
