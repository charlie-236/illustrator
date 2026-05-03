'use client';

import { useEffect, useRef, useState } from 'react';
import type { GenerationRecord, ProjectSummary } from '@/types';
import { imgSrc } from '@/lib/imageSrc';
import NewProjectModal from './NewProjectModal';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import ProjectPicker from './ProjectPicker';

interface Props {
  items: GenerationRecord[];
  startIndex: number;
  onClose: () => void;
  onRemix: (record: GenerationRecord) => void;
  /** Parent handles the API call. Throw on failure to keep the modal open. */
  onDelete: (id: string) => Promise<void>;
  /** Parent updates its own items state; modal does an optimistic local update. */
  onFavoriteToggle?: (id: string) => Promise<void>;
  onNavigateToProject?: (projectId: string) => void;
  /** Called after a successful project assignment. */
  onProjectAssign?: (generationId: string, projectId: string | null) => void;
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      fill={filled ? 'currentColor' : 'none'}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  );
}

export default function ImageModal({ items: initialItems, startIndex, onClose, onRemix, onDelete, onFavoriteToggle, onNavigateToProject, onProjectAssign }: Props) {
  const [items, setItems] = useState(initialItems);
  const [idx, setIdx] = useState(Math.min(startIndex, Math.max(0, initialItems.length - 1)));
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // Project picker state
  const [showPicker, setShowPicker] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);


  // Keep a ref to items.length so the keyboard handler never captures a stale value
  const itemsLenRef = useRef(items.length);
  useEffect(() => { itemsLenRef.current = items.length; }, [items.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showDeleteDialog) { setShowDeleteDialog(false); return; }
        if (showPicker) { setShowPicker(false); return; }
        if (showNewProjectModal) return;
        onClose();
        return;
      }
      if (showDeleteDialog || showPicker || showNewProjectModal) return;
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, itemsLenRef.current - 1));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, showDeleteDialog, showPicker, showNewProjectModal]);

  // Close the delete dialog when navigating to a different item
  useEffect(() => { setShowDeleteDialog(false); }, [idx]);

  // Close picker when navigating
  useEffect(() => { setShowPicker(false); }, [idx]);

  const record = items[idx] ?? null;

  function goTo(newIdx: number) {
    if (newIdx >= 0 && newIdx < items.length) setIdx(newIdx);
  }

  async function confirmDeleteRecord() {
    if (!record) return;
    setShowDeleteDialog(false);
    setDeleting(true);
    try {
      await onDelete(record.id);
      const next = items.filter((_, i) => i !== idx);
      if (next.length === 0) { onClose(); return; }
      setItems(next);
      setIdx((prev) => Math.min(prev, next.length - 1));
    } catch {
      // delete failed — stay put, user can retry
    } finally {
      setDeleting(false);
    }
  }

  async function handleFavoriteToggle() {
    if (!record || !onFavoriteToggle) return;
    const newVal = !record.isFavorite;
    // Optimistic local update
    setItems((prev) => prev.map((item, i) => i === idx ? { ...item, isFavorite: newVal } : item));
    try {
      await onFavoriteToggle(record.id);
    } catch {
      // Revert on failure
      setItems((prev) => prev.map((item, i) => i === idx ? { ...item, isFavorite: !newVal } : item));
    }
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 48) return;
    if (dx < 0) goTo(idx + 1);
    else goTo(idx - 1);
  }

  async function assignProject(projectId: string | null, projectName: string | null) {
    if (!record) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/generations/${record.id}/project`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) return;
      setItems((prev) => prev.map((item, i) =>
        i === idx ? { ...item, projectId, projectName } : item,
      ));
      onProjectAssign?.(record.id, projectId);
      setShowPicker(false);
    } finally {
      setAssigning(false);
    }
  }

  if (!record) return null;

  const isVideo = record.mediaType === 'video';
  const modelShort = record.model.split('/').pop()?.replace(/\.(safetensors|ckpt|pt)$/i, '') ?? record.model;
  const date = new Date(record.createdAt).toLocaleString();


  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">

      {/* ── Top bar: Close · counter · Favorite · Remix · Delete ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-950 border-b border-zinc-800 flex-shrink-0">

        <button
          onClick={onClose}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-xl text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors flex-shrink-0"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <span className="flex-1 text-center text-sm text-zinc-400">
          {items.length > 1 ? `${idx + 1} / ${items.length}` : ''}
        </span>

        {/* Favorite */}
        {onFavoriteToggle && (
          <button
            onClick={handleFavoriteToggle}
            className={`min-h-12 min-w-12 flex items-center justify-center rounded-xl transition-colors flex-shrink-0
              ${record.isFavorite
                ? 'text-red-400 bg-red-600/15 hover:bg-red-600/25'
                : 'text-zinc-400 hover:text-red-400 hover:bg-zinc-800'}`}
            aria-label={record.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <HeartIcon filled={record.isFavorite} />
          </button>
        )}

        {/* Remix */}
        <button
          onClick={() => { onRemix(record); onClose(); }}
          className="min-h-12 px-4 flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-semibold text-sm transition-colors flex-shrink-0"
          aria-label="Remix — send params to Studio"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Remix
        </button>

        {/* Delete */}
        <button
          onClick={() => setShowDeleteDialog(true)}
          disabled={deleting}
          className="min-h-12 px-4 flex items-center gap-2 rounded-xl font-semibold text-sm transition-colors flex-shrink-0 disabled:opacity-50 bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
          aria-label="Delete"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete
        </button>
      </div>

      {/* ── Media area ── */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden bg-black"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            key={record.id}
            src={imgSrc(record.filePath)}
            controls
            autoPlay
            loop
            playsInline
            className="max-w-full max-h-full object-contain select-none"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={record.id}
            src={imgSrc(record.filePath)}
            alt={record.promptPos.slice(0, 80)}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
          />
        )}

        {idx > 0 && (
          <button
            onClick={() => goTo(idx - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-black/55 hover:bg-black/80 text-white backdrop-blur-sm transition-colors"
            aria-label="Previous"
          >
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {idx < items.length - 1 && (
          <button
            onClick={() => goTo(idx + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 min-h-12 min-w-12 flex items-center justify-center rounded-xl bg-black/55 hover:bg-black/80 text-white backdrop-blur-sm transition-colors"
            aria-label="Next"
          >
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Bottom metadata ── */}
      <div className="bg-zinc-950 border-t border-zinc-800 px-4 py-3 flex-shrink-0 space-y-1.5">
        <p className="text-sm text-zinc-200 leading-relaxed line-clamp-2">{record.promptPos}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span className="text-xs text-zinc-400">{modelShort}</span>
          {record.lora && <span className="text-xs text-zinc-400">{record.lora}</span>}
          <span className="text-xs text-zinc-400">{record.width}×{record.height}</span>
          <span className="text-xs text-zinc-400">{record.steps} steps</span>
          <span className="text-xs text-zinc-400">CFG {record.cfg}</span>
          <span className="text-xs text-zinc-400 tabular-nums">Seed {record.seed}</span>
          {isVideo ? (
            <>
              {record.frames != null && <span className="text-xs text-zinc-400">{record.frames} frames</span>}
              {record.fps != null && <span className="text-xs text-zinc-400">{record.fps} fps</span>}
            </>
          ) : (
            <>
              <span className="text-xs text-zinc-400">{record.sampler}/{record.scheduler}</span>
              {record.highResFix && <span className="text-xs text-violet-400 font-medium">HRF 2×</span>}
            </>
          )}
        </div>
        <p className="text-xs text-zinc-600">{date}</p>

        {/* Project row — shown for all non-stitched clips (image and video) */}
        {!record.isStitched && (
          <div className="relative">
            <p className="text-xs text-zinc-500">
              {'Project: '}
              <button
                onClick={() => setShowPicker(true)}
                disabled={assigning}
                className="text-violet-400 hover:text-violet-300 underline underline-offset-2 disabled:opacity-50"
              >
                {record.projectId && record.projectName ? record.projectName : 'None'}
              </button>
            </p>

            <ProjectPicker
              open={showPicker}
              currentProjectId={record.projectId}
              title="Assign to project"
              busy={assigning}
              onClose={() => setShowPicker(false)}
              onSelect={(projectId, projectName) => void assignProject(projectId, projectName)}
              onCreateNew={() => { setShowPicker(false); setShowNewProjectModal(true); }}
            />
          </div>
        )}

        {record.isStitched && (
          <>
            <p className="text-xs text-zinc-500">
              {'Stitched from project: '}
              {record.parentProjectId && record.parentProjectName ? (
                <button
                  onClick={() => { onNavigateToProject?.(record.parentProjectId!); onClose(); }}
                  className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
                >
                  {record.parentProjectName}
                </button>
              ) : (
                <span className="text-zinc-600">Project deleted</span>
              )}
            </p>
            {record.stitchedClipIds && (() => {
              try {
                const raw = JSON.parse(record.stitchedClipIds);
                if (Array.isArray(raw)) {
                  // Phase 3 format: plain string[]
                  return <p className="text-xs text-zinc-500">Source clips: {raw.length}</p>;
                }
                // Phase 3.1 format: { selected: string[], total: number }
                const { selected, total } = raw as { selected: string[]; total: number };
                const projectLabel = record.parentProjectName ?? null;
                return (
                  <p className="text-xs text-zinc-500">
                    Source clips: {selected.length} of {total}
                    {projectLabel ? ` from project ${projectLabel}` : ''}
                  </p>
                );
              } catch {
                return null;
              }
            })()}
          </>
        )}
      </div>

      {/* New project modal — opens on top of everything */}
      {showNewProjectModal && (
        <NewProjectModal
          onClose={() => setShowNewProjectModal(false)}
          onCreated={async (project) => {
            setShowNewProjectModal(false);
            await assignProject(project.id, project.name);
          }}
        />
      )}

      {/* Delete confirm dialog */}
      {record && (
        <DeleteConfirmDialog
          open={showDeleteDialog}
          resourceType="clip"
          resourceName={record.promptPos.slice(0, 60)}
          onConfirm={(_cascade: boolean) => { void confirmDeleteRecord(); }}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </div>
  );
}
