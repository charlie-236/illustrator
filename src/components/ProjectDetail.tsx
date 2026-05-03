'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ProjectClip, ProjectDetail, GenerationRecord, ProjectStitchedExport } from '@/types';
import ImageModal from './ImageModal';
import { imgSrc } from '@/lib/imageSrc';
import { useQueue } from '@/contexts/QueueContext';

interface Props {
  projectId: string;
  onBack: () => void;
  onDeleted: () => void;
  onNavigateToGallery: () => void;
  onGenerateInProject: (project: ProjectDetail, latestClip: ProjectClip | null) => void;
}

const VIDEO_RESOLUTIONS = [
  { label: '1280×704', w: 1280, h: 704 },
  { label: '768×768', w: 768, h: 768 },
  { label: '704×1280', w: 704, h: 1280 },
];

function clipToRecord(clip: ProjectClip, projectId: string, projectName: string): GenerationRecord {
  return {
    id: clip.id,
    filePath: clip.filePath,
    promptPos: clip.prompt,
    promptNeg: '',
    model: 'wan2.2',
    lora: null,
    lorasJson: null,
    assembledPos: null,
    assembledNeg: null,
    seed: '0',
    cfg: 3.5,
    steps: 20,
    width: clip.width,
    height: clip.height,
    sampler: 'euler',
    scheduler: 'simple',
    highResFix: false,
    isFavorite: clip.isFavorite,
    mediaType: 'video',
    frames: clip.frames,
    fps: clip.fps,
    projectId,
    projectName,
    isStitched: false,
    parentProjectId: null,
    parentProjectName: null,
    stitchedClipIds: null,
    createdAt: clip.createdAt,
  };
}

// ─────────────────────────────────────────────
// Stitch modal
// ─────────────────────────────────────────────

interface StitchModalProps {
  projectId: string;
  projectName: string;
  clipCount: number;
  onClose: () => void;
  onStitched: (export_: ProjectStitchedExport) => void;
}

function StitchModal({ projectId, projectName, clipCount, onClose, onStitched }: StitchModalProps) {
  const [transition, setTransition] = useState<'hard-cut' | 'crossfade'>('hard-cut');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { addJob, setCompleting, completeJob, failJob } = useQueue();

  async function handleStitch() {
    setStatus('running');
    setProgress(null);
    setErrorMsg(null);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch(`/api/projects/${projectId}/stitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        setStatus('error');
        setErrorMsg('Failed to start stitch');
        return;
      }

      let promptId: string | null = null;
      let generationId: string | null = null;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        let eventName = '';
        for (const line of lines) {
          if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (eventName === 'init') {
            const parsed = JSON.parse(data) as { promptId: string; generationId: string };
            promptId = parsed.promptId;
            generationId = parsed.generationId;
            addJob({
              promptId,
              generationId,
              mediaType: 'stitch',
              promptSummary: `Stitched: ${projectName}`.slice(0, 60),
              startedAt: Date.now(),
              progress: null,
              status: 'running',
            });
          } else if (eventName === 'progress') {
            const parsed = JSON.parse(data) as { value: number; max: number };
            setProgress({ current: parsed.value, total: parsed.max });
            if (promptId) {
              // progress update via queue happens via polling; just update local state
            }
          } else if (eventName === 'completing') {
            if (promptId) setCompleting(promptId);
          } else if (eventName === 'complete') {
            const result = JSON.parse(data) as { id: string; filePath: string; frames: number; fps: number; createdAt: string };
            if (promptId && generationId) completeJob(promptId, generationId);
            setStatus('done');
            onStitched({
              id: result.id,
              filePath: result.filePath,
              frames: result.frames,
              fps: result.fps,
              createdAt: result.createdAt,
              promptPos: `Stitched: ${projectName}`,
            });
          } else if (eventName === 'error') {
            const parsed = JSON.parse(data) as { message: string };
            if (promptId) failJob(promptId, parsed.message);
            setStatus('error');
            setErrorMsg(parsed.message);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setStatus('error');
      setErrorMsg(String(err));
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={status === 'idle' ? onClose : undefined}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">Stitch project</h2>
          {status !== 'running' && (
            <button onClick={onClose} className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">
          {status === 'idle' && (
            <>
              <p className="text-sm text-zinc-400">
                Combine {clipCount} clips into a single mp4 file. The stitched video will appear in your Gallery.
              </p>

              <div>
                <label className="label block mb-2">Transition</label>
                <div className="flex gap-2">
                  {(['hard-cut', 'crossfade'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTransition(t)}
                      className={`flex-1 min-h-12 rounded-xl text-sm font-medium border transition-colors
                        ${transition === t
                          ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                    >
                      {t === 'hard-cut' ? 'Hard cut' : 'Crossfade (0.5s)'}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={() => void handleStitch()}
                className="w-full min-h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors"
              >
                Stitch {clipCount} clips
              </button>
            </>
          )}

          {status === 'running' && (
            <div className="space-y-3 py-1">
              <p className="text-sm text-zinc-300">
                {progress ? `Processing frame ${progress.current} / ${progress.total}…` : 'Starting ffmpeg…'}
              </p>
              {progress && (
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                    style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }}
                  />
                </div>
              )}
              <button
                onClick={handleAbort}
                className="w-full min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Abort
              </button>
            </div>
          )}

          {status === 'done' && (
            <div className="py-1 space-y-3">
              <p className="text-sm text-emerald-400 font-medium">Stitch complete! The video is now in your Gallery.</p>
              <button
                onClick={onClose}
                className="w-full min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="py-1 space-y-3">
              <p className="text-sm text-red-400 break-words">{errorMsg ?? 'Stitch failed'}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setStatus('idle'); setErrorMsg(null); }}
                  className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                >
                  Try again
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Sortable clip tile
// ─────────────────────────────────────────────

interface SortableClipTileProps {
  clip: ProjectClip;
  index: number;
  onClick: () => void;
}

function SortableClipTile({ clip, index, onClick }: SortableClipTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const durationSec = clip.fps > 0 ? (clip.frames / clip.fps).toFixed(1) : '0.0';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative flex-shrink-0 w-36 rounded-lg overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors cursor-pointer group"
      {...attributes}
      {...listeners}
      onClick={onClick}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={imgSrc(clip.filePath)}
        preload="metadata"
        muted
        playsInline
        className="w-full aspect-video object-cover bg-zinc-800"
      />
      {/* Position badge */}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-bold select-none pointer-events-none">
        {index + 1}
      </div>
      {/* Duration badge */}
      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium select-none pointer-events-none">
        {durationSec}s
      </div>
      {/* Drag handle hint on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
    </div>
  );
}

// ─────────────────────────────────────────────
// Settings / defaults modal
// ─────────────────────────────────────────────

interface SettingsModalProps {
  project: ProjectDetail;
  onClose: () => void;
  onSaved: (updated: ProjectDetail) => void;
}

function SettingsModal({ project, onClose, onSaved }: SettingsModalProps) {
  const [form, setForm] = useState({
    description: project.description ?? '',
    styleNote: project.styleNote ?? '',
    defaultFrames: project.defaultFrames != null ? String(project.defaultFrames) : '',
    defaultSteps: project.defaultSteps != null ? String(project.defaultSteps) : '',
    defaultCfg: project.defaultCfg != null ? String(project.defaultCfg) : '',
    defaultWidth: project.defaultWidth != null ? String(project.defaultWidth) : '',
    defaultHeight: project.defaultHeight != null ? String(project.defaultHeight) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {
      description: form.description.trim() || null,
      styleNote: form.styleNote.trim() || null,
      defaultFrames: form.defaultFrames ? parseInt(form.defaultFrames, 10) : null,
      defaultSteps: form.defaultSteps ? parseInt(form.defaultSteps, 10) : null,
      defaultCfg: form.defaultCfg ? parseFloat(form.defaultCfg) : null,
      defaultWidth: form.defaultWidth ? parseInt(form.defaultWidth, 10) : null,
      defaultHeight: form.defaultHeight ? parseInt(form.defaultHeight, 10) : null,
    };
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Save failed'); return; }
      onSaved(data as ProjectDetail);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">Project Settings</h2>
          <button onClick={onClose} className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <div>
            <label className="label block mb-1">Description</label>
            <textarea
              className="input-base resize-none"
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Short description of the project"
            />
          </div>

          <div>
            <label className="label block mb-1">Style note</label>
            <textarea
              className="input-base resize-none"
              rows={3}
              value={form.styleNote}
              onChange={(e) => set('styleNote', e.target.value)}
              placeholder="Creative anchor — tone, visual style, key constraints…"
            />
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <p className="text-xs text-zinc-500 mb-3 uppercase tracking-wide font-medium">Default generation settings</p>

            <div>
              <label className="label block mb-1">Resolution</label>
              <div className="flex gap-2 flex-wrap">
                {VIDEO_RESOLUTIONS.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => { set('defaultWidth', String(r.w)); set('defaultHeight', String(r.h)); }}
                    className={`px-3 min-h-12 rounded-lg text-sm border transition-colors
                      ${form.defaultWidth === String(r.w) && form.defaultHeight === String(r.h)
                        ? 'border-violet-500 bg-violet-600/20 text-violet-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => { set('defaultWidth', ''); set('defaultHeight', ''); }}
                  className={`px-3 min-h-12 rounded-lg text-sm border transition-colors
                    ${!form.defaultWidth && !form.defaultHeight
                      ? 'border-violet-500 bg-violet-600/20 text-violet-300'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                >
                  None
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="label block mb-1">Default frames</label>
                <input
                  className="input-base"
                  type="number"
                  min={17} max={121} step={8}
                  value={form.defaultFrames}
                  onChange={(e) => set('defaultFrames', e.target.value)}
                  placeholder="57 (inherit)"
                />
              </div>
              <div>
                <label className="label block mb-1">Default steps</label>
                <input
                  className="input-base"
                  type="number"
                  min={4} max={40} step={2}
                  value={form.defaultSteps}
                  onChange={(e) => set('defaultSteps', e.target.value)}
                  placeholder="20 (inherit)"
                />
              </div>
            </div>

            <div className="mt-3">
              <label className="label block mb-1">Default CFG</label>
              <input
                className="input-base"
                type="number"
                min={1} max={10} step={0.1}
                value={form.defaultCfg}
                onChange={(e) => set('defaultCfg', e.target.value)}
                placeholder="3.5 (inherit)"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-12 rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main ProjectDetail view
// ─────────────────────────────────────────────

export default function ProjectDetailView({ projectId, onBack, onDeleted, onNavigateToGallery, onGenerateInProject }: Props) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [clips, setClips] = useState<ProjectClip[]>([]);
  const [stitchedExports, setStitchedExports] = useState<ProjectStitchedExport[]>([]);
  const [showStitch, setShowStitch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [modalIdx, setModalIdx] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState('');
  const [descSaving, setDescSaving] = useState(false);

  // Play-through state
  const [playThrough, setPlayThrough] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(0);
  const [playDone, setPlayDone] = useState(false);
  const playerRef = useRef<HTMLVideoElement>(null);

  // When the active clip index changes in play-through mode, reload and play
  useEffect(() => {
    if (!playThrough || !playerRef.current) return;
    playerRef.current.load();
    void playerRef.current.play().catch(() => { /* autoplay blocked — user can tap play */ });
  }, [playingIdx, playThrough]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) { onBack(); return; }
      const data = await res.json();
      setProject(data.project);
      setClips(data.clips ?? []);
      setStitchedExports(data.stitchedExports ?? []);
      setNameValue(data.project.name);
      setDescValue(data.project.description ?? '');
    } finally {
      setLoading(false);
    }
  }, [projectId, onBack]);

  useEffect(() => { void load(); }, [load]);

  // Close overflow on outside click
  useEffect(() => {
    if (!showOverflow) return;
    function handler(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showOverflow]);

  useEffect(() => () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  async function saveName() {
    if (!project || nameValue.trim() === '' || nameValue.trim() === project.name) {
      setEditingName(false);
      setNameValue(project?.name ?? '');
      return;
    }
    setNameSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameValue.trim() }),
      });
      const data = await res.json();
      if (res.ok) setProject(data);
    } finally {
      setNameSaving(false);
      setEditingName(false);
    }
  }

  async function saveDescription() {
    if (!project) { setEditingDesc(false); return; }
    const newDesc = descValue.trim() || null;
    if (newDesc === (project.description ?? null)) { setEditingDesc(false); return; }
    setDescSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newDesc }),
      });
      const data = await res.json();
      if (res.ok) setProject(data);
    } finally {
      setDescSaving(false);
      setEditingDesc(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIdx = clips.findIndex((c) => c.id === active.id);
    const newIdx = clips.findIndex((c) => c.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const newClips = arrayMove(clips, oldIdx, newIdx);
    setClips(newClips); // optimistic

    try {
      const res = await fetch(`/api/projects/${projectId}/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipOrder: newClips.map((c) => c.id) }),
      });
      if (!res.ok) {
        setClips(clips); // revert
        setReorderError('Reorder failed — reverted');
        setTimeout(() => setReorderError(null), 3000);
      }
    } catch {
      setClips(clips); // revert
      setReorderError('Reorder failed — reverted');
      setTimeout(() => setReorderError(null), 3000);
    }
  }

  const modalRecords = clips.map((c) => clipToRecord(c, projectId, project?.name ?? ''));

  if (loading || !project) {
    return (
      <div className="px-4 py-4 animate-pulse space-y-4">
        <div className="h-6 bg-zinc-800 rounded w-48" />
        <div className="h-4 bg-zinc-800 rounded w-32" />
        <div className="flex gap-3 mt-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-36 aspect-video rounded-lg bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-6">
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={onBack}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 -ml-2"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-xs text-zinc-500">Projects</span>
        </div>

        {/* Editable name */}
        <div className="flex items-start gap-2">
          {editingName ? (
            <input
              ref={nameInputRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void saveName(); }
                if (e.key === 'Escape') { setEditingName(false); setNameValue(project.name); }
              }}
              className="input-base text-xl font-bold flex-1"
              autoFocus
              disabled={nameSaving}
            />
          ) : (
            <button
              onClick={() => { setEditingName(true); setTimeout(() => nameInputRef.current?.select(), 10); }}
              className="text-xl font-bold text-zinc-100 hover:text-white text-left flex-1 min-h-12 flex items-center"
              title="Click to edit name"
            >
              {project.name}
            </button>
          )}

          {/* Settings button */}
          <button
            onClick={() => setShowSettings(true)}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            title="Project settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Overflow menu (delete) */}
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setShowOverflow((s) => !s)}
              className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="More options"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
            </button>

            {showOverflow && (
              <div className="absolute right-0 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl z-30 min-w-44 overflow-hidden">
                <button
                  onClick={() => { setShowOverflow(false); void handleDelete(); }}
                  disabled={deleting}
                  className={`w-full min-h-12 px-4 flex items-center gap-3 text-sm font-medium transition-colors
                    ${confirmDelete
                      ? 'bg-red-600 text-white'
                      : 'text-red-400 hover:bg-zinc-800'}`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  {confirmDelete ? 'Tap again to confirm' : 'Delete project'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Editable description */}
        <div className="mt-2">
          {editingDesc ? (
            <textarea
              ref={descriptionRef}
              value={descValue}
              onChange={(e) => setDescValue(e.target.value)}
              onBlur={saveDescription}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setEditingDesc(false); setDescValue(project.description ?? ''); }
              }}
              className="input-base resize-none text-sm w-full"
              rows={2}
              placeholder="Add a description…"
              disabled={descSaving}
              autoFocus
            />
          ) : (
            <button
              onClick={() => setEditingDesc(true)}
              className="text-sm text-zinc-400 hover:text-zinc-200 text-left w-full min-h-10 py-1"
              title="Click to edit description"
            >
              {project.description || <span className="text-zinc-600 italic">Add a description…</span>}
            </button>
          )}
        </div>

        {/* Style note */}
        {project.styleNote && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
            <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-1">Style note</p>
            <p className="text-sm text-zinc-300 leading-relaxed">{project.styleNote}</p>
          </div>
        )}
      </div>

      {/* ── Generate new clip + Stitch ── */}
      <div className="px-4 pt-4 pb-2 flex gap-2">
        <button
          onClick={() => onGenerateInProject(project, clips[clips.length - 1] ?? null)}
          className="flex-1 min-h-12 rounded-xl border border-violet-600/40 bg-violet-600/10 hover:bg-violet-600/20 hover:border-violet-600/60 text-violet-300 hover:text-violet-200 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Generate new clip
        </button>
        <button
          onClick={() => setShowStitch(true)}
          disabled={clips.length < 2}
          title={clips.length < 2 ? 'Need at least 2 clips to stitch' : `Stitch ${clips.length} clips`}
          className="min-h-12 px-4 rounded-xl border border-emerald-600/40 bg-emerald-600/10 hover:bg-emerald-600/20 hover:border-emerald-600/60 text-emerald-300 hover:text-emerald-200 text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Stitch
        </button>
      </div>

      {/* ── Clip strip / play-through ── */}
      <div className="px-4 pt-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            {clips.length === 0 ? 'No clips' : `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`}
          </p>
          <div className="flex items-center gap-2">
            {clips.length > 1 && (
              <button
                onClick={() => {
                  setPlayThrough((v) => {
                    if (!v) { setPlayingIdx(0); setPlayDone(false); }
                    return !v;
                  });
                }}
                className={`min-h-10 px-3 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5
                  ${playThrough
                    ? 'bg-violet-600/20 border-violet-600/30 text-violet-300'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                </svg>
                {playThrough ? 'Strip view' : 'Play all'}
              </button>
            )}
            {clips.length > 1 && !playThrough && (
              <p className="text-xs text-zinc-600">Drag to reorder</p>
            )}
          </div>
        </div>

        {reorderError && (
          <p className="text-xs text-red-400 mb-2">{reorderError}</p>
        )}

        {clips.length === 0 ? (
          <div className="flex items-center justify-center h-32 rounded-xl border border-dashed border-zinc-700 text-zinc-600 text-sm">
            No clips yet. Tap &quot;Generate new clip&quot; above to get started.
          </div>
        ) : playThrough ? (
          /* ── Play-through player ── */
          <div className="space-y-3">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={playerRef}
              src={imgSrc(clips[playingIdx]?.filePath ?? '')}
              controls
              autoPlay
              playsInline
              onEnded={() => {
                if (playingIdx < clips.length - 1) {
                  setPlayingIdx((i) => i + 1);
                  setPlayDone(false);
                } else {
                  setPlayDone(true);
                }
              }}
              className="w-full rounded-xl bg-zinc-800"
            />

            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-400 tabular-nums">
                Clip {playingIdx + 1} of {clips.length}
              </p>
              {playDone && (
                <button
                  onClick={() => { setPlayingIdx(0); setPlayDone(false); }}
                  className="min-h-10 px-3 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors"
                >
                  Play again
                </button>
              )}
            </div>

            {/* Clip chips */}
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
              {clips.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => { setPlayingIdx(i); setPlayDone(false); }}
                  className={`flex-shrink-0 min-h-10 min-w-10 px-3 rounded-lg text-xs font-bold border transition-colors
                    ${i === playingIdx
                      ? 'bg-violet-600/20 border-violet-600/30 text-violet-300'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Sortable strip ── */
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-3 overflow-x-auto pb-2" style={{ WebkitOverflowScrolling: 'touch' }}>
                {clips.map((clip, i) => (
                  <SortableClipTile
                    key={clip.id}
                    clip={clip}
                    index={i}
                    onClick={() => setModalIdx(i)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* ── Clip modal ── */}
      {modalIdx !== null && (
        <ImageModal
          items={modalRecords}
          startIndex={modalIdx}
          onClose={() => setModalIdx(null)}
          onRemix={() => {}}
          onDelete={async (id) => {
            const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            setClips((prev) => prev.filter((c) => c.id !== id));
          }}
          onFavoriteToggle={async (id) => {
            const clip = clips.find((c) => c.id === id);
            if (!clip) return;
            await fetch(`/api/generation/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isFavorite: !clip.isFavorite }),
            });
            setClips((prev) => prev.map((c) => c.id === id ? { ...c, isFavorite: !c.isFavorite } : c));
          }}
        />
      )}

      {/* ── Stitched exports ── */}
      {stitchedExports.length > 0 && (
        <div className="px-4 pt-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-2">
            Stitched exports ({stitchedExports.length})
          </p>
          <div className="space-y-2">
            {stitchedExports.map((e) => {
              const durSec = e.frames != null && e.fps != null && e.fps > 0
                ? (e.frames / e.fps).toFixed(1)
                : null;
              return (
                <div key={e.id} className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={imgSrc(e.filePath)}
                    preload="metadata"
                    muted
                    playsInline
                    className="flex-shrink-0 w-20 aspect-video rounded-lg object-cover bg-zinc-800"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-300 truncate">{e.promptPos}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {durSec ? `${durSec}s` : ''}
                      {durSec && e.frames ? ' · ' : ''}
                      {e.frames != null ? `${e.frames} frames` : ''}
                      {' · '}
                      {new Date(e.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <a
                    href={imgSrc(e.filePath)}
                    download
                    className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                    title="Download"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Settings modal ── */}
      {showSettings && (
        <SettingsModal
          project={project}
          onClose={() => setShowSettings(false)}
          onSaved={(updated) => { setProject(updated); setShowSettings(false); }}
        />
      )}

      {/* ── Stitch modal ── */}
      {showStitch && (
        <StitchModal
          projectId={projectId}
          projectName={project.name}
          clipCount={clips.length}
          onClose={() => setShowStitch(false)}
          onStitched={(export_) => {
            setStitchedExports((prev) => [export_, ...prev]);
            setShowStitch(false);
          }}
        />
      )}
    </div>
  );
}
