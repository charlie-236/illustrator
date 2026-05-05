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
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ProjectClip, ProjectDetail, GenerationRecord, ProjectStitchedExport, WanLoraEntry, Storyboard, StoryboardScene, ProjectContext } from '@/types';
import ImageModal from './ImageModal';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import StoryboardGenerationModal from './StoryboardGenerationModal';
import SceneEditModal from './SceneEditModal';
import CanonicalClipPickerModal from './CanonicalClipPickerModal';
import { imgSrc } from '@/lib/imageSrc';
import { useQueue } from '@/contexts/QueueContext';
import { useModelLists } from '@/lib/useModelLists';
import VideoLoraStack from './VideoLoraStack';

interface Props {
  projectId: string;
  onBack: () => void;
  onDeleted: () => void;
  onNavigateToGallery: () => void;
  onGenerateInProject: (project: ProjectDetail, latestClip: ProjectClip | null, mode: 'image' | 'video', sceneContext?: ProjectContext['sceneContext']) => void;
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
    model: clip.mediaType === 'image' ? 'unknown' : 'wan2.2',
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
    mediaType: clip.mediaType,
    frames: clip.frames || null,
    fps: clip.fps || null,
    projectId: clip.isStitched ? null : projectId,
    projectName: clip.isStitched ? null : projectName,
    isStitched: clip.isStitched,
    parentProjectId: clip.isStitched ? projectId : null,
    parentProjectName: clip.isStitched ? projectName : null,
    stitchedClipIds: null,
    videoLorasJson: null,
    lightning: null,
    sceneId: clip.sceneId ?? null,
    createdAt: clip.createdAt,
  };
}

/**
 * Resolves the canonical clip ID for a scene.
 * Uses scene.canonicalClipId if set and the clip still exists, otherwise falls back
 * to the earliest-created clip with matching sceneId.
 */
function resolveCanonicalClipId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  if (scene.canonicalClipId) {
    if (projectClips.some((c) => c.id === scene.canonicalClipId)) {
      return scene.canonicalClipId;
    }
  }
  const sceneClips = projectClips
    .filter((c) => c.sceneId === scene.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return sceneClips[0]?.id ?? null;
}

function stitchedExportToRecord(e: ProjectStitchedExport, projectId: string, projectName: string): GenerationRecord {
  return {
    id: e.id,
    filePath: e.filePath,
    promptPos: e.promptPos,
    promptNeg: '',
    model: 'wan2.2',
    lora: null,
    lorasJson: null,
    assembledPos: null,
    assembledNeg: null,
    seed: '0',
    cfg: 3.5,
    steps: 20,
    width: e.width,
    height: e.height,
    sampler: 'euler',
    scheduler: 'simple',
    highResFix: false,
    isFavorite: false,
    mediaType: 'video',
    frames: e.frames,
    fps: e.fps,
    projectId: null,
    projectName: null,
    isStitched: true,
    parentProjectId: projectId,
    parentProjectName: projectName,
    stitchedClipIds: null,
    videoLorasJson: null,
    lightning: null,
    sceneId: null,
    createdAt: e.createdAt,
  };
}

// ─────────────────────────────────────────────
// Stitch modal
// ─────────────────────────────────────────────

interface StitchModalProps {
  projectId: string;
  projectName: string;
  /** All video clips in the project, in position order. */
  videoClips: ProjectClip[];
  /** All clips (video + image) — used to compute each video clip's project-wide position number. */
  allClips: ProjectClip[];
  onClose: () => void;
  onStitched: (export_: ProjectStitchedExport) => void;
}

function StitchModal({ projectId, projectName, videoClips, allClips, onClose, onStitched }: StitchModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(videoClips.map((c) => c.id)),
  );
  const [transition, setTransition] = useState<'hard-cut' | 'crossfade'>('hard-cut');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { addJob, setCompleting, completeJob, failJob } = useQueue();

  const selectedClips = videoClips.filter((c) => selectedIds.has(c.id));
  const totalDurationSec = selectedClips.reduce(
    (s, c) => s + (c.fps > 0 ? c.frames / c.fps : 0),
    0,
  );
  const canStitch = selectedClips.length >= 2;

  function toggleClip(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll(select: boolean) {
    setSelectedIds(select ? new Set(videoClips.map((c) => c.id)) : new Set());
  }

  async function handleStitch() {
    setStatus('running');
    setProgress(null);
    setErrorMsg(null);
    const ac = new AbortController();
    abortRef.current = ac;

    const clipIds = videoClips.filter((c) => selectedIds.has(c.id)).map((c) => c.id);

    try {
      const res = await fetch(`/api/projects/${projectId}/stitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition, clipIds }),
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
              runningSince: Date.now(),
              progress: null,
              status: 'running',
            });
          } else if (eventName === 'progress') {
            const parsed = JSON.parse(data) as { value: number; max: number };
            setProgress({ current: parsed.value, total: parsed.max });
          } else if (eventName === 'completing') {
            if (promptId) setCompleting(promptId);
          } else if (eventName === 'complete') {
            const parsed = JSON.parse(data) as { records: GenerationRecord[] };
            const record = parsed.records[0];
            if (!record) {
              setStatus('error');
              setErrorMsg('Stitch completed but no record returned');
              return;
            }
            if (promptId && generationId) completeJob(promptId, generationId);
            setStatus('done');
            onStitched({
              id: record.id,
              filePath: record.filePath,
              frames: record.frames ?? 0,
              fps: record.fps ?? 0,
              width: record.width,
              height: record.height,
              createdAt: record.createdAt,
              promptPos: record.promptPos,
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
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md"
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
              {videoClips.length === 0 ? (
                <p className="text-sm text-zinc-400 py-2">
                  This project has no clips to stitch. Add video clips first.
                </p>
              ) : (
                <>
                  {/* Select all / deselect all + live summary */}
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-zinc-300">
                      Stitching {selectedClips.length} of {videoClips.length} clip{videoClips.length !== 1 ? 's' : ''}
                      {selectedClips.length > 0 && `, ${totalDurationSec.toFixed(1)}s total`}
                    </p>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => toggleAll(true)}
                        className="text-xs text-emerald-400 hover:text-emerald-300 min-h-8 px-1"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleAll(false)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 min-h-8 px-1"
                      >
                        Deselect all
                      </button>
                    </div>
                  </div>

                  {/* Per-clip selection list */}
                  <div className="max-h-64 overflow-y-auto -mx-1 space-y-1">
                    {videoClips.map((clip) => {
                      const posNum = allClips.indexOf(clip) + 1;
                      const durationSec = clip.fps > 0 ? (clip.frames / clip.fps).toFixed(1) : null;
                      const checked = selectedIds.has(clip.id);
                      return (
                        <label
                          key={clip.id}
                          className={`flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors
                            ${checked ? 'bg-emerald-600/10 border border-emerald-700/30' : 'border border-transparent hover:bg-zinc-800'}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleClip(clip.id)}
                            className="w-4 h-4 rounded accent-emerald-500 flex-shrink-0"
                          />
                          {/* Position badge */}
                          <span className="flex-shrink-0 w-6 h-6 rounded bg-zinc-700 text-zinc-300 text-xs font-bold flex items-center justify-center">
                            {posNum}
                          </span>
                          {/* Thumbnail */}
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <video
                            src={imgSrc(clip.filePath)}
                            preload="metadata"
                            muted
                            playsInline
                            className="flex-shrink-0 w-10 h-10 rounded object-cover bg-zinc-800"
                          />
                          {/* Prompt + duration */}
                          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                            <span className="text-xs text-zinc-300 truncate">
                              {clip.prompt.slice(0, 60) || '(no prompt)'}
                            </span>
                            {durationSec && (
                              <span className="text-xs text-zinc-500">{durationSec}s</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  {/* Transition selector */}
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

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleStitch()}
                      disabled={!canStitch}
                      className="flex-1 min-h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Stitch {selectedClips.length} clips
                    </button>
                  </div>
                </>
              )}
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

  const isVideo = clip.mediaType === 'video';
  const durationSec = isVideo && clip.fps > 0 ? (clip.frames / clip.fps).toFixed(1) : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative flex-shrink-0 w-36 rounded-lg overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors cursor-pointer group"
      {...attributes}
      {...listeners}
      onClick={onClick}
    >
      {isVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={imgSrc(clip.filePath)}
          preload="metadata"
          muted
          playsInline
          className="w-full aspect-video object-cover bg-zinc-800"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgSrc(clip.filePath)}
          alt={clip.prompt.slice(0, 40)}
          className="w-full aspect-video object-cover bg-zinc-800"
        />
      )}
      {/* Position badge */}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-bold select-none pointer-events-none">
        {index + 1}
      </div>
      {/* Duration badge — video only */}
      {durationSec !== null && (
        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium select-none pointer-events-none">
          {durationSec}s
        </div>
      )}
      {/* Drag handle hint on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
    </div>
  );
}

// ─────────────────────────────────────────────
// Non-draggable stitched output tile
// ─────────────────────────────────────────────

interface StitchedTileProps {
  clip: ProjectClip;
  onClick: () => void;
}

function StitchedTile({ clip, onClick }: StitchedTileProps) {
  const durationSec = clip.fps > 0 ? (clip.frames / clip.fps).toFixed(1) : null;

  return (
    <div
      className="relative flex-shrink-0 w-36 rounded-lg overflow-hidden border border-emerald-800/50 hover:border-emerald-700 transition-colors cursor-pointer group"
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
      {/* Stitched badge */}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-emerald-900/80 text-emerald-300 text-xs font-semibold select-none pointer-events-none">
        Stitched
      </div>
      {/* Duration badge */}
      {durationSec !== null && (
        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium select-none pointer-events-none">
          {durationSec}s
        </div>
      )}
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
  const { data: modelLists } = useModelLists();
  const [form, setForm] = useState({
    description: project.description ?? '',
    styleNote: project.styleNote ?? '',
    defaultFrames: project.defaultFrames != null ? String(project.defaultFrames) : '',
    defaultSteps: project.defaultSteps != null ? String(project.defaultSteps) : '',
    defaultCfg: project.defaultCfg != null ? String(project.defaultCfg) : '',
    defaultWidth: project.defaultWidth != null ? String(project.defaultWidth) : '',
    defaultHeight: project.defaultHeight != null ? String(project.defaultHeight) : '',
  });
  // tri-state: null = no default, true = always on, false = always off
  const [defaultLightning, setDefaultLightning] = useState<boolean | null>(
    project.defaultLightning ?? null,
  );
  const [defaultVideoLoras, setDefaultVideoLoras] = useState<WanLoraEntry[]>(() => {
    if (!project.defaultVideoLoras) return [];
    return project.defaultVideoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
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
    // Build full WanLoraSpec[] from the minimal WanLoraEntry[] + modelLists metadata
    const fullVideoLoras = defaultVideoLoras.length > 0
      ? defaultVideoLoras.map((e) => ({
          loraName: e.loraName,
          friendlyName: modelLists.loraNames[e.loraName] ?? '(unknown LoRA)',
          weight: e.weight,
          appliesToHigh: modelLists.loraAppliesToHigh[e.loraName] ?? true,
          appliesToLow: modelLists.loraAppliesToLow[e.loraName] ?? true,
        }))
      : null;

    const body: Record<string, unknown> = {
      description: form.description.trim() || null,
      styleNote: form.styleNote.trim() || null,
      defaultFrames: form.defaultFrames ? parseInt(form.defaultFrames, 10) : null,
      defaultSteps: form.defaultSteps ? parseInt(form.defaultSteps, 10) : null,
      defaultCfg: form.defaultCfg ? parseFloat(form.defaultCfg) : null,
      defaultWidth: form.defaultWidth ? parseInt(form.defaultWidth, 10) : null,
      defaultHeight: form.defaultHeight ? parseInt(form.defaultHeight, 10) : null,
      defaultLightning,
      defaultVideoLoras: fullVideoLoras,
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

            <div className="mt-3">
              <label className="label block mb-1">Default Lightning</label>
              <div className="flex gap-2">
                {([true, false, null] as const).map((val) => (
                  <button
                    key={String(val)}
                    type="button"
                    onClick={() => setDefaultLightning(val)}
                    className={`flex-1 min-h-12 rounded-lg text-sm border transition-colors
                      ${defaultLightning === val
                        ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500'}`}
                  >
                    {val === true ? '⚡ On' : val === false ? 'Off' : 'No default'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {defaultLightning === true
                  ? 'New clips will default to Lightning mode (4 steps, ~3 min).'
                  : defaultLightning === false
                    ? 'New clips will default to Lightning off (full quality).'
                    : 'No override — clips keep whatever Lightning state was last used.'}
              </p>
            </div>

            <div className="mt-3">
              <VideoLoraStack
                loras={defaultVideoLoras}
                lists={modelLists}
                onChange={setDefaultVideoLoras}
              />
              <p className="text-xs text-zinc-500 mt-1">New clips in this project pre-fill the LoRA stack from these defaults.</p>
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

  // Storyboard state
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [storyboardExpanded, setStoryboardExpanded] = useState(true);
  const [showStoryboardModal, setShowStoryboardModal] = useState(false);
  const [showStoryboardRegenConfirm, setShowStoryboardRegenConfirm] = useState(false);
  const [showStoryboardDeleteConfirm, setShowStoryboardDeleteConfirm] = useState(false);
  // Scene edit state
  const [editingScene, setEditingScene] = useState<StoryboardScene | null>(null);
  // Canonical clip picker state
  const [canonicalPickerScene, setCanonicalPickerScene] = useState<StoryboardScene | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [modalIdx, setModalIdx] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState('');
  const [descSaving, setDescSaving] = useState(false);

  // Strip media type filter: 'clips' = unstitched videos, 'videos' = stitched outputs
  const [stripFilter, setStripFilter] = useState<'all' | 'images' | 'clips' | 'videos'>('all');

  // Play-through state
  const [playThrough, setPlayThrough] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(0);
  const [playDone, setPlayDone] = useState(false);
  const playerRef = useRef<HTMLVideoElement>(null);

  // Unstitched video clips — used for play-through and stitch modal
  const videoClips = clips.filter((c) => c.mediaType === 'video' && !c.isStitched);

  // Filtered source clips for strip (stitched exports are always appended after)
  const filteredSourceClips = stripFilter === 'images'
    ? clips.filter((c) => c.mediaType === 'image')
    : stripFilter === 'clips'
      ? clips.filter((c) => c.mediaType === 'video' && !c.isStitched)
      : stripFilter === 'videos'
        ? [] // 'videos' = stitched exports only; source clips excluded
        : clips; // 'all' shows all source clips

  // Stitched exports shown in strip: only when filter is 'all' or 'videos'
  const filteredStitchedForStrip = (stripFilter === 'all' || stripFilter === 'videos')
    ? stitchedExports
    : [];

  // Whether to show the 4-way filter bar
  const hasImages = clips.some((c) => c.mediaType === 'image');
  const hasVideoClips = clips.some((c) => c.mediaType === 'video');
  const hasStitchedExports = stitchedExports.length > 0;
  const showFilterBar = !playThrough && [hasImages, hasVideoClips, hasStitchedExports].filter(Boolean).length > 1;

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
      setStoryboard(data.project.storyboard ?? null);
      setStoryboardExpanded(!!data.project.storyboard);
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

  async function confirmDeleteProject(cascade: boolean) {
    setShowDeleteDialog(false);
    setDeleting(true);
    try {
      const url = cascade
        ? `/api/projects/${projectId}?cascade=true`
        : `/api/projects/${projectId}`;
      await fetch(url, { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent('project-deleted', { detail: { id: projectId } }));
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  async function confirmDeleteStoryboard() {
    setShowStoryboardDeleteConfirm(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/storyboard`, { method: 'DELETE' });
      if (res.ok) setStoryboard(null);
    } catch {
      // silently ignore — storyboard stays rendered
    }
  }

  function handleGenerateScene(scene: StoryboardScene) {
    if (!project) return;
    const sceneIndex = scene.position;

    // Resolve previous scene's canonical clip for i2v chaining suggestion
    let suggestedStartingClipId: string | null = null;
    if (storyboard && sceneIndex > 0) {
      const prevScene = storyboard.scenes[sceneIndex - 1];
      if (prevScene) {
        suggestedStartingClipId = resolveCanonicalClipId(prevScene, clips);
      }
    }

    const latestClip = clips.length > 0 ? clips[clips.length - 1] : null;
    const sceneCtx: ProjectContext['sceneContext'] = {
      sceneId: scene.id,
      sceneIndex,
      prompt: scene.positivePrompt,
      durationSeconds: scene.durationSeconds,
      suggestedStartingClipId,
    };

    onGenerateInProject(project, latestClip, 'video', sceneCtx);
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

  // Modal records: all source clips + stitched exports
  const modalRecords = [
    ...clips.map((c) => clipToRecord(c, projectId, project?.name ?? '')),
    ...stitchedExports.map((e) => stitchedExportToRecord(e, projectId, project?.name ?? '')),
  ];

  function getModalIndexById(id: string): number {
    return modalRecords.findIndex((r) => r.id === id);
  }

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
                  onClick={() => { setShowOverflow(false); setShowDeleteDialog(true); }}
                  disabled={deleting}
                  className="w-full min-h-12 px-4 flex items-center gap-3 text-sm font-medium text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete project
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

      {/* ── Storyboard section ── */}
      <div className="px-4 pt-4 border-b border-zinc-800 pb-4">
        <button
          onClick={() => setStoryboardExpanded((v) => !v)}
          className="w-full flex items-center justify-between gap-2 group min-h-10"
        >
          <div className="flex items-center gap-2">
            <span className="text-base">📓</span>
            <span className="text-sm font-semibold text-zinc-200">Storyboard</span>
            {storyboard && (
              <span className="text-xs text-zinc-500">
                {storyboard.scenes.length} scene{storyboard.scenes.length !== 1 ? 's' : ''}
                {' · '}
                {new Date(storyboard.generatedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-zinc-500 transition-transform ${storyboardExpanded ? '' : '-rotate-90'}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {storyboardExpanded && (
          <div className="mt-3 space-y-3">
            {!storyboard ? (
              /* Empty state */
              <div className="rounded-xl border border-dashed border-zinc-700 p-5 text-center space-y-3">
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Plan your project with AI. Describe a story idea and generate a scene-by-scene outline you can use to guide your clips.
                </p>
                <button
                  type="button"
                  onClick={() => setShowStoryboardModal(true)}
                  className="min-h-12 px-5 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 hover:border-violet-600/50 text-violet-300 text-sm font-medium transition-colors"
                >
                  + Plan with AI
                </button>
              </div>
            ) : (
              /* Populated state */
              <div className="space-y-3">
                {storyboard.scenes.map((scene, i) => {
                  const sceneClips = clips.filter((c) => c.sceneId === scene.id);
                  const canonicalId = resolveCanonicalClipId(scene, clips);
                  const canonicalClip = canonicalId ? clips.find((c) => c.id === canonicalId) ?? null : null;

                  return (
                  <div
                    key={scene.id}
                    className="bg-zinc-800/60 rounded-xl p-3 space-y-2"
                  >
                    {/* Scene header row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-zinc-300">Scene {i + 1}</span>
                      <span className="text-xs text-zinc-500 bg-zinc-700/60 px-1.5 py-0.5 rounded">
                        {scene.durationSeconds}s
                      </span>
                      {sceneClips.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (sceneClips.length === 1) {
                              // Single clip: open ImageModal directly
                              const clipIdx = clips.findIndex((c) => c.id === sceneClips[0].id);
                              if (clipIdx !== -1) setModalIdx(getModalIndexById(sceneClips[0].id));
                            } else {
                              // Multiple clips: open canonical picker
                              setCanonicalPickerScene(scene);
                            }
                          }}
                          className="text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
                        >
                          {sceneClips.length} clip{sceneClips.length !== 1 ? 's' : ''}
                        </button>
                      )}
                    </div>

                    {/* Description */}
                    <p className="text-sm text-zinc-200 leading-relaxed">{scene.description}</p>
                    {/* Prompt */}
                    <p className="text-xs font-mono text-zinc-500 leading-relaxed break-words">
                      {scene.positivePrompt}
                    </p>
                    {/* Notes */}
                    {scene.notes && (
                      <p className="text-xs text-zinc-400 italic leading-relaxed">{scene.notes}</p>
                    )}

                    {/* Canonical clip thumbnail */}
                    {canonicalClip && (
                      <button
                        type="button"
                        onClick={() => {
                          const idx = getModalIndexById(canonicalClip.id);
                          if (idx !== -1) setModalIdx(idx);
                        }}
                        className="block w-1/2 rounded-lg overflow-hidden border border-zinc-700 hover:border-violet-500 transition-colors"
                      >
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <video
                          src={imgSrc(canonicalClip.filePath)}
                          preload="metadata"
                          muted
                          playsInline
                          className="w-full aspect-video object-cover bg-zinc-800"
                        />
                      </button>
                    )}

                    {/* Generate / Edit buttons */}
                    <div className="flex gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => handleGenerateScene(scene)}
                        className="flex-1 min-h-12 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 hover:border-violet-600/50 text-violet-300 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Generate this scene
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingScene(scene)}
                        className="min-h-12 min-w-12 rounded-xl bg-zinc-700/60 hover:bg-zinc-700 border border-zinc-600/40 text-zinc-400 hover:text-zinc-200 text-sm transition-colors flex items-center justify-center"
                        title="Edit scene"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  );
                })}

                {/* Regenerate / Delete actions */}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowStoryboardRegenConfirm(true)}
                    className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                  >
                    Regenerate
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowStoryboardDeleteConfirm(true)}
                    className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-red-400 text-sm font-medium transition-colors"
                  >
                    Delete storyboard
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Generate image / clip + Stitch ── */}
      <div className="px-4 pt-4 pb-2 flex gap-2">
        <div className="flex gap-2 flex-1">
          <button
            onClick={() => onGenerateInProject(project, clips[clips.length - 1] ?? null, 'image')}
            className="flex-1 min-h-12 rounded-xl border border-violet-600/40 bg-violet-600/10 hover:bg-violet-600/20 hover:border-violet-600/60 text-violet-300 hover:text-violet-200 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Generate image
          </button>
          <button
            onClick={() => onGenerateInProject(project, clips[clips.length - 1] ?? null, 'video')}
            className="flex-1 min-h-12 rounded-xl border border-violet-600/40 bg-violet-600/10 hover:bg-violet-600/20 hover:border-violet-600/60 text-violet-300 hover:text-violet-200 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Generate clip
          </button>
        </div>
        <button
          onClick={() => setShowStitch(true)}
          disabled={clips.length === 0}
          title={clips.length === 0 ? 'No clips to stitch' : undefined}
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
            {clips.length === 0 && stitchedExports.length === 0
              ? 'No items'
              : `${clips.length + stitchedExports.length} ${clips.length + stitchedExports.length === 1 ? 'item' : 'items'}`}
          </p>
          <div className="flex items-center gap-2">
            {/* Play-through toggle — only visible when ≥2 video clips */}
            {videoClips.length > 1 && (
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
            {!playThrough && clips.length > 1 && (
              <p className="text-xs text-zinc-600">Drag to reorder</p>
            )}
          </div>
        </div>

        {/* 4-way filter: All / Images / Clips / Videos */}
        {showFilterBar && (
          <div className="flex gap-1.5 mb-3 flex-wrap">
            {(
              [
                { key: 'all', label: 'All' },
                ...(hasImages ? [{ key: 'images', label: 'Images' }] : []),
                ...(hasVideoClips ? [{ key: 'clips', label: 'Clips' }] : []),
                ...(hasStitchedExports ? [{ key: 'videos', label: 'Videos' }] : []),
              ] as { key: 'all' | 'images' | 'clips' | 'videos'; label: string }[]
            ).map((f) => (
              <button
                key={f.key}
                onClick={() => setStripFilter(f.key)}
                className={`min-h-8 px-3 rounded-lg text-xs font-medium border transition-colors
                  ${stripFilter === f.key
                    ? 'border-violet-500 bg-violet-600/20 text-violet-300'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {reorderError && (
          <p className="text-xs text-red-400 mb-2">{reorderError}</p>
        )}

        {clips.length === 0 && stitchedExports.length === 0 ? (
          <div className="flex items-center justify-center h-32 rounded-xl border border-dashed border-zinc-700 text-zinc-600 text-sm">
            No items yet. Tap &quot;Generate image&quot; or &quot;Generate clip&quot; above to get started.
          </div>
        ) : playThrough ? (
          /* ── Play-through player (video clips only) ── */
          <div className="space-y-3">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={playerRef}
              src={imgSrc(videoClips[playingIdx]?.filePath ?? '')}
              controls
              autoPlay
              playsInline
              onEnded={() => {
                if (playingIdx < videoClips.length - 1) {
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
                Clip {playingIdx + 1} of {videoClips.length}
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
              {videoClips.map((c, i) => (
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
          /* ── Wrapping strip: sortable source clips + non-draggable stitched outputs ── */
          <div className="flex flex-wrap gap-3">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={clips.map((c) => c.id)} strategy={rectSortingStrategy}>
                {filteredSourceClips.map((clip) => (
                  <SortableClipTile
                    key={clip.id}
                    clip={clip}
                    index={clips.indexOf(clip)}
                    onClick={() => setModalIdx(getModalIndexById(clip.id))}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {filteredStitchedForStrip.map((e) => {
              const asClip: ProjectClip = {
                id: e.id,
                filePath: e.filePath,
                prompt: e.promptPos,
                frames: e.frames ?? 0,
                fps: e.fps ?? 16,
                width: e.width,
                height: e.height,
                position: Number.MAX_SAFE_INTEGER,
                createdAt: e.createdAt,
                isFavorite: false,
                mediaType: 'video',
                isStitched: true,
                sceneId: null,
              };
              return (
                <StitchedTile
                  key={e.id}
                  clip={asClip}
                  onClick={() => setModalIdx(getModalIndexById(e.id))}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Clip / stitched modal ── */}
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
            setStitchedExports((prev) => prev.filter((e) => e.id !== id));
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
          onProjectAssign={(id, newProjectId) => {
            if (newProjectId !== projectId) {
              // Clip was moved away from this project — remove from strip
              setClips((prev) => prev.filter((c) => c.id !== id));
            }
          }}
          storyboard={storyboard}
        />
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
          videoClips={videoClips}
          allClips={clips}
          onClose={() => setShowStitch(false)}
          onStitched={(export_) => {
            // Prepend to stitchedExports — the new stitch becomes the most recent
            setStitchedExports((prev) => [export_, ...prev]);
            setShowStitch(false);
          }}
        />
      )}

      {/* ── Delete confirm dialog ── */}
      <DeleteConfirmDialog
        open={showDeleteDialog}
        resourceType="project"
        resourceName={project.name}
        cascadeInfo={{ itemCount: clips.length, stitchCount: stitchedExports.length }}
        onConfirm={(cascade: boolean) => { void confirmDeleteProject(cascade); }}
        onCancel={() => setShowDeleteDialog(false)}
      />

      {/* ── Storyboard generation modal ── */}
      {showStoryboardModal && (
        <StoryboardGenerationModal
          projectId={projectId}
          initialStoryIdea={storyboard?.storyIdea ?? ''}
          onClose={() => setShowStoryboardModal(false)}
          onSaved={(sb) => { setStoryboard(sb); setStoryboardExpanded(true); }}
        />
      )}

      {/* ── Storyboard regenerate confirm ── */}
      {showStoryboardRegenConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowStoryboardRegenConfirm(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">Replace storyboard?</h2>
            <p className="text-sm text-zinc-400">
              This will replace your existing storyboard with a new one. The current scenes will be lost. Any clips already generated for this project will remain.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowStoryboardRegenConfirm(false)}
                className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowStoryboardRegenConfirm(false);
                  setShowStoryboardModal(true);
                }}
                className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Storyboard delete confirm ── */}
      {showStoryboardDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowStoryboardDeleteConfirm(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">Delete storyboard?</h2>
            <p className="text-sm text-zinc-400">
              This removes the scene plan only. Project clips are not affected.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowStoryboardDeleteConfirm(false)}
                className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void confirmDeleteStoryboard(); }}
                className="flex-1 min-h-12 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scene edit modal ── */}
      {editingScene && storyboard && (
        <SceneEditModal
          scene={editingScene}
          sceneIndex={editingScene.position}
          totalScenes={storyboard.scenes.length}
          projectId={projectId}
          storyboard={storyboard}
          onClose={() => setEditingScene(null)}
          onSaved={(updated) => { setStoryboard(updated); setEditingScene(null); }}
        />
      )}

      {/* ── Canonical clip picker ── */}
      {canonicalPickerScene && storyboard && (
        <CanonicalClipPickerModal
          scene={canonicalPickerScene}
          sceneIndex={canonicalPickerScene.position}
          sceneClips={clips.filter((c) => c.sceneId === canonicalPickerScene.id)}
          canonicalClipId={resolveCanonicalClipId(canonicalPickerScene, clips)}
          projectId={projectId}
          projectName={project?.name ?? ''}
          storyboard={storyboard}
          onClose={() => setCanonicalPickerScene(null)}
          onCanonicalChanged={(updated) => setStoryboard(updated)}
        />
      )}
    </div>
  );
}
