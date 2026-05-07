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
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ProjectClip, ProjectDetail, GenerationRecord, ProjectStitchedExport, WanLoraEntry, Storyboard, StoryboardScene, ProjectContext } from '@/types';
import ImageModal from './ImageModal';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import StoryboardGenerationModal from './StoryboardGenerationModal';
import SceneEditModal from './SceneEditModal';
import CanonicalClipPickerModal from './CanonicalClipPickerModal';
import CanonicalKeyframePickerModal from './CanonicalKeyframePickerModal';
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
    storyboardId: null,
    createdAt: clip.createdAt,
  };
}

/**
 * Resolves the canonical video clip ID for a scene.
 * Uses scene.canonicalClipId if set and the clip still exists (must be video),
 * otherwise falls back to the earliest-created video clip with matching sceneId.
 */
function resolveCanonicalClipId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  const videoClips = projectClips.filter((c) => c.sceneId === scene.id && c.mediaType === 'video');
  if (scene.canonicalClipId && videoClips.some((c) => c.id === scene.canonicalClipId)) {
    return scene.canonicalClipId;
  }
  const earliest = videoClips.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  return earliest?.id ?? null;
}

/**
 * Resolves the canonical keyframe ID for a scene.
 * Uses scene.canonicalKeyframeId if set and the keyframe still exists (must be image),
 * otherwise falls back to the earliest-created image clip with matching sceneId.
 */
function resolveCanonicalKeyframeId(scene: StoryboardScene, projectClips: ProjectClip[]): string | null {
  const keyframes = projectClips.filter((c) => c.sceneId === scene.id && c.mediaType === 'image');
  if (scene.canonicalKeyframeId && keyframes.some((k) => k.id === scene.canonicalKeyframeId)) {
    return scene.canonicalKeyframeId;
  }
  const earliest = keyframes.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  return earliest?.id ?? null;
}

// ── Phase 5c helpers ──────────────────────────────────────────────────────────

const VALID_FRAME_COUNTS = [17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121] as const;

function clampToValidFrameCount(n: number): number {
  let best: number = VALID_FRAME_COUNTS[0];
  let minDist = Math.abs(n - best);
  for (const f of VALID_FRAME_COUNTS) {
    const dist = Math.abs(n - f);
    if (dist < minDist) { minDist = dist; best = f; }
  }
  return best;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

async function encodeImageToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function readLastUsedImageCheckpoint(): string | null {
  try { return sessionStorage.getItem('studio-last-image-checkpoint'); } catch { return null; }
}

async function readInitEvent(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Stream ended before init event');
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';
      for (const message of messages) {
        if (!message.includes('event: init')) continue;
        const dataLine = message.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(6)) as { promptId: string };
        return data.promptId;
      }
    }
  } finally {
    reader.cancel().catch(() => { /* ignore */ });
  }
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
    storyboardId: e.storyboardId ?? null,
    createdAt: e.createdAt,
  };
}

// ─────────────────────────────────────────────
// Sortable scene card (for scene reordering)
// ─────────────────────────────────────────────

interface SortableSceneCardProps {
  scene: StoryboardScene;
  sceneIndex: number;
  sceneClips: ProjectClip[];
  canonicalClip: ProjectClip | null;
  canonicalId: string | null;
  sceneKeyframes: ProjectClip[];
  canonicalKeyframe: ProjectClip | null;
  canonicalKeyframeId: string | null;
  compactMode: boolean;
  showFull: boolean;
  isInFlight: boolean;
  inFlightEntry: { startedAt: number; promptId: string } | undefined;
  isKeyframeInFlight: boolean;
  keyframeInFlightEntry: { startedAt: number; promptId: string } | undefined;
  nowTick: number;
  quickGenerateError: { sceneId: string; message: string } | null;
  keyframeError: { sceneId: string; message: string } | null;
  onExpand: () => void;
  onEdit: () => void;
  onGenerate: () => void;
  onGenerateKeyframe: () => void;
  onOpenClips: () => void;
  onOpenCanonical: () => void;
  onOpenKeyframes: () => void;
  onOpenCanonicalKeyframe: () => void;
  onDismissError: () => void;
  onDismissKeyframeError: () => void;
}

function SortableSceneCard({
  scene,
  sceneIndex,
  sceneClips,
  canonicalClip,
  sceneKeyframes,
  canonicalKeyframe,
  compactMode,
  showFull,
  isInFlight,
  inFlightEntry,
  isKeyframeInFlight,
  keyframeInFlightEntry,
  nowTick,
  quickGenerateError,
  keyframeError,
  onExpand,
  onEdit,
  onGenerate,
  onGenerateKeyframe,
  onOpenClips,
  onOpenCanonical,
  onOpenKeyframes,
  onOpenCanonicalKeyframe,
  onDismissError,
  onDismissKeyframeError,
}: SortableSceneCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: scene.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="bg-zinc-800/60 rounded-xl overflow-hidden">
      {compactMode ? (
        /* Compact row */
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Drag handle */}
          <button
            type="button"
            className="flex-shrink-0 min-h-8 min-w-6 flex items-center justify-center text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing touch-none"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
            </svg>
          </button>
          <span className="flex-shrink-0 text-xs font-bold text-zinc-400 w-5 text-center">{sceneIndex + 1}</span>
          <button
            type="button"
            onClick={onExpand}
            className="flex-1 min-h-10 text-left text-sm text-zinc-300 truncate"
          >
            {scene.description}
          </button>
          <span className="flex-shrink-0 text-xs text-zinc-500 bg-zinc-700/60 px-1.5 py-0.5 rounded">{scene.durationSeconds}s</span>
          {sceneKeyframes.length > 0 && (
            <button type="button" onClick={onOpenKeyframes} className="flex-shrink-0 text-xs text-sky-400 hover:text-sky-300 min-h-8 px-1" title="Keyframes">
              🖼 {sceneKeyframes.length}
            </button>
          )}
          {sceneClips.length > 0 && (
            <button type="button" onClick={onOpenClips} className="flex-shrink-0 text-xs text-violet-400 hover:text-violet-300 min-h-8 px-1" title="Clips">
              🎬 {sceneClips.length}
            </button>
          )}
          {isKeyframeInFlight ? (
            <div className="flex-shrink-0 flex items-center gap-1 text-xs text-sky-400">
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              🖼 {formatElapsed(nowTick - (keyframeInFlightEntry?.startedAt ?? nowTick))}
            </div>
          ) : (
            <button
              type="button"
              onClick={onGenerateKeyframe}
              className="flex-shrink-0 min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-600/30 text-sky-300 transition-colors"
              title="Generate keyframe"
            >
              🖼
            </button>
          )}
          {isInFlight ? (
            <div className="flex-shrink-0 flex items-center gap-1 text-xs text-zinc-400">
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {formatElapsed(nowTick - (inFlightEntry?.startedAt ?? nowTick))}
            </div>
          ) : (
            <button
              type="button"
              onClick={onGenerate}
              className="flex-shrink-0 min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 text-violet-300 transition-colors"
              title="Generate this scene"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            className="flex-shrink-0 min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-zinc-700/60 hover:bg-zinc-700 border border-zinc-600/40 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Edit scene"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>
      ) : (
        /* Full card */
        <div className="p-3 space-y-2">
          {/* Scene header row */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Drag handle */}
            <button
              type="button"
              className="flex-shrink-0 min-h-8 min-w-6 flex items-center justify-center text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing touch-none"
              {...attributes}
              {...listeners}
              aria-label="Drag to reorder"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
              </svg>
            </button>
            <span className="text-xs font-bold text-zinc-300">Scene {sceneIndex + 1}</span>
            <span className="text-xs text-zinc-500 bg-zinc-700/60 px-1.5 py-0.5 rounded">
              {scene.durationSeconds}s
            </span>
            {sceneKeyframes.length > 0 && (
              <button
                type="button"
                onClick={onOpenKeyframes}
                className="text-xs text-sky-400 hover:text-sky-300 underline underline-offset-2"
              >
                🖼 {sceneKeyframes.length} keyframe{sceneKeyframes.length !== 1 ? 's' : ''}
              </button>
            )}
            {sceneClips.length > 0 && (
              <button
                type="button"
                onClick={onOpenClips}
                className="text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
              >
                🎬 {sceneClips.length} clip{sceneClips.length !== 1 ? 's' : ''}
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

          {/* Dual thumbnails: keyframe (left) + clip (right) */}
          {(canonicalKeyframe || canonicalClip) && (
            <div className="flex gap-2">
              {/* Keyframe thumbnail */}
              <div className="flex-1">
                {canonicalKeyframe ? (
                  <button
                    type="button"
                    onClick={onOpenCanonicalKeyframe}
                    className="block w-full rounded-lg overflow-hidden border border-sky-700/50 hover:border-sky-500 transition-colors"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imgSrc(canonicalKeyframe.filePath)}
                      alt=""
                      className="w-full aspect-video object-cover bg-zinc-800"
                    />
                  </button>
                ) : (
                  <div className="w-full aspect-video rounded-lg bg-zinc-800/40 border border-dashed border-zinc-700/40 flex items-center justify-center text-zinc-600 text-xs">
                    🖼
                  </div>
                )}
              </div>
              {/* Clip thumbnail */}
              <div className="flex-1">
                {canonicalClip ? (
                  <button
                    type="button"
                    onClick={onOpenCanonical}
                    className="block w-full rounded-lg overflow-hidden border border-zinc-700 hover:border-violet-500 transition-colors"
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
                ) : (
                  <div className="w-full aspect-video rounded-lg bg-zinc-800/40 border border-dashed border-zinc-700/40 flex items-center justify-center text-zinc-600 text-xs">
                    🎬
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Quick-generate error banner */}
          {quickGenerateError?.sceneId === scene.id && (
            <div className="flex items-start gap-2 bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="flex-1 text-xs text-red-300 leading-relaxed">
                {quickGenerateError.message}
              </span>
              <button
                type="button"
                onClick={onDismissError}
                className="min-w-8 min-h-8 flex items-center justify-center rounded text-red-400 hover:text-red-200 flex-shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Keyframe error banner */}
          {keyframeError?.sceneId === scene.id && (
            <div className="flex items-start gap-2 bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="flex-1 text-xs text-red-300 leading-relaxed">
                Keyframe: {keyframeError.message}
              </span>
              <button
                type="button"
                onClick={onDismissKeyframeError}
                className="min-w-8 min-h-8 flex items-center justify-center rounded text-red-400 hover:text-red-200 flex-shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Generate keyframe + Generate scene + Edit buttons */}
          <div className="flex gap-2 pt-0.5">
            {isKeyframeInFlight ? (
              <div className="flex-1 min-h-12 rounded-xl bg-sky-900/30 border border-sky-700/40 text-sky-400 text-sm flex items-center justify-center gap-2 cursor-not-allowed select-none">
                <svg className="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                🖼 {formatElapsed(nowTick - (keyframeInFlightEntry?.startedAt ?? nowTick))}
              </div>
            ) : (
              <button
                type="button"
                onClick={onGenerateKeyframe}
                className="flex-1 min-h-12 rounded-xl bg-sky-600/15 hover:bg-sky-600/25 border border-sky-600/25 hover:border-sky-600/45 text-sky-300 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
              >
                🖼 Keyframe
              </button>
            )}
            {isInFlight ? (
              <div className="flex-1 min-h-12 rounded-xl bg-zinc-700/60 border border-zinc-600/40 text-zinc-400 text-sm flex items-center justify-center gap-2 cursor-not-allowed select-none">
                <svg className="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating... {formatElapsed(nowTick - (inFlightEntry?.startedAt ?? nowTick))}
              </div>
            ) : (
              <button
                type="button"
                onClick={onGenerate}
                className="flex-1 min-h-12 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 hover:border-violet-600/50 text-violet-300 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Video
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              className="min-h-12 min-w-12 rounded-xl bg-zinc-700/60 hover:bg-zinc-700 border border-zinc-600/40 text-zinc-400 hover:text-zinc-200 text-sm transition-colors flex items-center justify-center"
              title="Edit scene"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
  /** If provided, only these clip IDs are pre-selected (order is preserved for stitching). */
  initialClipIds?: string[];
  /** If set, passed to the stitch API so the output is named/associated with this storyboard. */
  storyboardId?: string;
  onClose: () => void;
  onStitched: (export_: ProjectStitchedExport) => void;
}

function StitchModal({ projectId, projectName, videoClips, allClips, initialClipIds, storyboardId, onClose, onStitched }: StitchModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialClipIds ?? videoClips.map((c) => c.id)),
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

    // Preserve initialClipIds order when provided; fall back to videoClips position order.
    const orderedIds = initialClipIds
      ? initialClipIds.filter((id) => selectedIds.has(id))
      : videoClips.filter((c) => selectedIds.has(c.id)).map((c) => c.id);
    const clipIds = orderedIds;

    const stitchBody: Record<string, unknown> = { transition, clipIds };
    if (storyboardId) stitchBody.storyboardId = storyboardId;

    try {
      const res = await fetch(`/api/projects/${projectId}/stitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stitchBody),
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
              storyboardId: record.storyboardId ?? null,
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
  const [defaultCheckpoint, setDefaultCheckpoint] = useState<string>(
    project.defaultCheckpoint ?? '',
  );
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
      defaultCheckpoint: defaultCheckpoint.trim() || null,
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
              <label className="label block mb-1">Default Image Checkpoint</label>
              <select
                className="input-base"
                value={defaultCheckpoint}
                onChange={(e) => setDefaultCheckpoint(e.target.value)}
              >
                <option value="">— No default (use last-used checkpoint) —</option>
                {(modelLists?.checkpoints ?? []).map((cp) => (
                  <option key={cp} value={cp}>{cp}</option>
                ))}
              </select>
              <p className="text-xs text-zinc-500 mt-1">Used for keyframe generation from this project's storyboards.</p>
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
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);
  const [storyboardExpanded, setStoryboardExpanded] = useState(true);
  const [compactMode, setCompactMode] = useState(false);
  const [expandedSceneIds, setExpandedSceneIds] = useState<Set<string>>(new Set());
  const [showStoryboardModal, setShowStoryboardModal] = useState(false);
  const [showCreateStoryboardModal, setShowCreateStoryboardModal] = useState(false);
  const [newStoryboardName, setNewStoryboardName] = useState('');
  const [creatingStoryboard, setCreatingStoryboard] = useState(false);
  const [showStoryboardRegenConfirm, setShowStoryboardRegenConfirm] = useState(false);
  const [showStoryboardDeleteConfirm, setShowStoryboardDeleteConfirm] = useState(false);
  const [renamingStoryboardId, setRenamingStoryboardId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [tabMenuStoryboardId, setTabMenuStoryboardId] = useState<string | null>(null);
  const [tabMenuPos, setTabMenuPos] = useState<{top: number; right: number} | null>(null);
  // Scene edit state
  const [editingScene, setEditingScene] = useState<StoryboardScene | null>(null);
  const [insertAtPosition, setInsertAtPosition] = useState<number | null>(null);
  // Canonical clip picker state
  const [canonicalPickerScene, setCanonicalPickerScene] = useState<StoryboardScene | null>(null);
  // Canonical play/stitch state
  const [canonicalStitchClipIds, setCanonicalStitchClipIds] = useState<string[]>([]);
  const [canonicalStitchStoryboardId, setCanonicalStitchStoryboardId] = useState<string | null>(null);
  const [playCanonical, setPlayCanonical] = useState(false);
  const [playingCanonicalIdx, setPlayingCanonicalIdx] = useState(0);
  const [playCanonicalDone, setPlayCanonicalDone] = useState(false);
  const canonicalPlayerRef = useRef<HTMLVideoElement>(null);

  // Derived: selected storyboard
  const storyboard = storyboards.find((s) => s.id === selectedStoryboardId) ?? null;
  const tabMenuStoryboard = storyboards.find((s) => s.id === tabMenuStoryboardId) ?? null;

  // Phase 5c: Quick-generate state
  const [inFlightScenes, setInFlightScenes] = useState<Map<string, { startedAt: number; promptId: string }>>(new Map());
  const [quickGenerateError, setQuickGenerateError] = useState<{ sceneId: string; message: string } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Phase 6: Keyframe generation state
  const [inFlightKeyframeScenes, setInFlightKeyframeScenes] = useState<Map<string, { startedAt: number; promptId: string }>>(new Map());
  const [keyframeError, setKeyframeError] = useState<{ sceneId: string; message: string } | null>(null);
  const [batchKeyframeScenes, setBatchKeyframeScenes] = useState<Set<string>>(new Set());
  const [canonicalKeyframePickerScene, setCanonicalKeyframePickerScene] = useState<StoryboardScene | null>(null);
  const [showBatchKeyframeConfirm, setShowBatchKeyframeConfirm] = useState(false);
  const [showRegenerateAllConfirm, setShowRegenerateAllConfirm] = useState(false);

  const { data: modelLists } = useModelLists();

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

  // Persist selected storyboard tab to sessionStorage
  useEffect(() => {
    if (selectedStoryboardId && project) {
      sessionStorage.setItem(`storyboard-tab-${project.id}`, selectedStoryboardId);
    }
  }, [selectedStoryboardId, project?.id]);

  // Load compactMode from sessionStorage when selected storyboard changes
  useEffect(() => {
    if (!selectedStoryboardId) return;
    const saved = sessionStorage.getItem(`storyboard-compact-${selectedStoryboardId}`);
    setCompactMode(saved === 'true');
  }, [selectedStoryboardId]);

  // Persist compactMode to sessionStorage
  useEffect(() => {
    if (selectedStoryboardId) {
      sessionStorage.setItem(`storyboard-compact-${selectedStoryboardId}`, String(compactMode));
    }
  }, [compactMode, selectedStoryboardId]);

  // Canonical player: load and play when playingCanonicalIdx changes
  useEffect(() => {
    if (!playCanonical || !canonicalPlayerRef.current) return;
    canonicalPlayerRef.current.load();
    void canonicalPlayerRef.current.play().catch(() => {});
  }, [playingCanonicalIdx, playCanonical]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { addJob } = useQueue();

  // Ref so polling closures always read the latest inFlightScenes without re-creating the interval
  const inFlightScenesRef = useRef<Map<string, { startedAt: number; promptId: string }>>(new Map());
  inFlightScenesRef.current = inFlightScenes;
  const inFlightKeyframeScenesRef = useRef<Map<string, { startedAt: number; promptId: string }>>(new Map());
  inFlightKeyframeScenesRef.current = inFlightKeyframeScenes;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) { onBack(); return; }
      const data = await res.json();
      setProject(data.project);
      setClips(data.clips ?? []);
      setStitchedExports(data.stitchedExports ?? []);
      const sbs: Storyboard[] = data.project.storyboards ?? [];
      setStoryboards(sbs);
      if (sbs.length > 0) {
        setStoryboardExpanded(true);
        const savedId = typeof window !== 'undefined' ? sessionStorage.getItem(`storyboard-tab-${data.project.id}`) : null;
        setSelectedStoryboardId(savedId && sbs.some((s: Storyboard) => s.id === savedId) ? savedId : sbs[0].id);
      } else {
        setStoryboardExpanded(false);
        setSelectedStoryboardId(null);
      }
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

  // Phase 5c/6: tick every second while any scenes are in-flight (drives elapsed display)
  useEffect(() => {
    if (inFlightScenes.size === 0 && inFlightKeyframeScenes.size === 0) return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [inFlightScenes.size, inFlightKeyframeScenes.size]);

  // Phase 5c/6: poll for completion while any scenes are in-flight (video or keyframe)
  useEffect(() => {
    if (inFlightScenes.size === 0 && inFlightKeyframeScenes.size === 0) return;
    const STALE_INFLIGHT_MS = 30 * 60 * 1000;
    const interval = setInterval(async () => {
      const currentInFlight = inFlightScenesRef.current;
      const currentKeyframeInFlight = inFlightKeyframeScenesRef.current;
      if (currentInFlight.size === 0 && currentKeyframeInFlight.size === 0) return;
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) return;
        const data = await res.json() as { project: typeof project; clips: ProjectClip[]; stitchedExports: typeof stitchedExports };
        const freshClips: ProjectClip[] = data.clips ?? [];
        const now = Date.now();

        // Handle video in-flight completions
        const videoToRemove: string[] = [];
        const videoStaleIds: string[] = [];
        for (const [sceneId, entry] of currentInFlight.entries()) {
          const newClip = freshClips.find(
            (c) => c.sceneId === sceneId && c.mediaType === 'video' && new Date(c.createdAt).getTime() > entry.startedAt,
          );
          if (newClip) {
            videoToRemove.push(sceneId);
          } else if (now - entry.startedAt > STALE_INFLIGHT_MS) {
            videoToRemove.push(sceneId);
            videoStaleIds.push(sceneId);
          }
        }
        if (videoToRemove.length > 0) {
          setInFlightScenes((prev) => {
            const next = new Map(prev);
            for (const id of videoToRemove) next.delete(id);
            return next;
          });
        }
        if (videoStaleIds.length > 0) {
          setQuickGenerateError({ sceneId: videoStaleIds[0], message: 'Generation appears to have timed out' });
        }

        // Handle keyframe in-flight completions
        const keyframeToRemove: string[] = [];
        const keyframeStaleIds: string[] = [];
        // Accumulate per-storyboard canonical updates (batched to handle multiple completions)
        const storyboardCanonicalUpdates = new Map<string, Storyboard>();
        const freshStoryboards: Storyboard[] = (data.project?.storyboards ?? []) as Storyboard[];
        for (const [sceneId, entry] of currentKeyframeInFlight.entries()) {
          const newKeyframe = freshClips.find(
            (c) => c.sceneId === sceneId && c.mediaType === 'image' && new Date(c.createdAt).getTime() > entry.startedAt,
          );
          if (newKeyframe) {
            keyframeToRemove.push(sceneId);
            // Auto-promote to canonical: find the storyboard containing this scene
            for (const sb of freshStoryboards) {
              const targetScene = sb.scenes.find((s) => s.id === sceneId);
              if (!targetScene) continue;
              const base = storyboardCanonicalUpdates.get(sb.id) ?? sb;
              const updatedScenes = base.scenes.map((s) =>
                s.id === sceneId ? { ...s, canonicalKeyframeId: newKeyframe.id } : s,
              );
              storyboardCanonicalUpdates.set(sb.id, { ...base, scenes: updatedScenes });
              break;
            }
          } else if (now - entry.startedAt > STALE_INFLIGHT_MS) {
            keyframeToRemove.push(sceneId);
            keyframeStaleIds.push(sceneId);
          }
        }
        if (keyframeToRemove.length > 0) {
          setInFlightKeyframeScenes((prev) => {
            const next = new Map(prev);
            for (const id of keyframeToRemove) next.delete(id);
            return next;
          });
          // Update batch tracking: clear scenes that are no longer in-flight
          setBatchKeyframeScenes((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set(prev);
            for (const id of keyframeToRemove) next.delete(id);
            return next;
          });
        }
        if (keyframeStaleIds.length > 0) {
          setKeyframeError({ sceneId: keyframeStaleIds[0], message: 'Keyframe generation appears to have timed out' });
        }
        // Fire canonical auto-promote PUTs (fire-and-forget; failure just means manual re-promote needed)
        for (const [sbId, updatedSb] of storyboardCanonicalUpdates) {
          void fetch(`/api/storyboards/${sbId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storyboard: updatedSb }),
          }).then((res) => {
            if (res.ok) setStoryboards((prev) => prev.map((s) => s.id === sbId ? updatedSb : s));
          }).catch((err) => console.warn('Failed to auto-promote keyframe to canonical:', err));
        }

        // Refresh project data so scene cards update
        setClips(freshClips);
        if (data.project) setProject(data.project);
        if (data.project?.storyboards) setStoryboards(data.project.storyboards);
        if (data.stitchedExports) setStitchedExports(data.stitchedExports);
      } catch { /* ignore poll errors */ }
    }, 5000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightScenes.size, inFlightKeyframeScenes.size, projectId]);

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
    if (!selectedStoryboardId) return;
    try {
      const res = await fetch(`/api/storyboards/${selectedStoryboardId}`, { method: 'DELETE' });
      if (res.ok) {
        setStoryboards((prev) => {
          const next = prev.filter((s) => s.id !== selectedStoryboardId);
          setSelectedStoryboardId(next[0]?.id ?? null);
          return next;
        });
      }
    } catch {
      // silently ignore
    }
  }

  async function handleQuickGenerateToggle() {
    if (!storyboard) return;
    const updated: Storyboard = { ...storyboard, quickGenerate: !storyboard.quickGenerate };
    setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    try {
      await fetch(`/api/storyboards/${storyboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updated }),
      });
    } catch {
      setStoryboards((prev) => prev.map((s) => s.id === storyboard.id ? storyboard : s));
    }
  }

  async function handleRenameStoryboard() {
    if (!renamingStoryboardId || renameSaving) return;
    const name = renameValue.trim();
    if (!name) { setRenamingStoryboardId(null); return; }
    if (name.length > 100) return;
    const sb = storyboards.find((s) => s.id === renamingStoryboardId);
    if (!sb || name === sb.name) { setRenamingStoryboardId(null); return; }
    setRenameSaving(true);
    const updated: Storyboard = { ...sb, name };
    try {
      const res = await fetch(`/api/storyboards/${renamingStoryboardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updated }),
      });
      if (res.ok) {
        setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s));
        setRenamingStoryboardId(null);
      }
    } finally {
      setRenameSaving(false);
    }
  }

  async function handleCreateStoryboard() {
    if (!project || creatingStoryboard) return;
    const name = newStoryboardName.trim() || `Storyboard ${storyboards.length + 1}`;
    setCreatingStoryboard(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/storyboards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const data = await res.json() as { storyboard: Storyboard };
        setStoryboards((prev) => [...prev, data.storyboard]);
        setSelectedStoryboardId(data.storyboard.id);
        setShowCreateStoryboardModal(false);
        setNewStoryboardName('');
      }
    } finally {
      setCreatingStoryboard(false);
    }
  }

  async function handleSceneDragEnd(event: DragEndEvent) {
    if (!storyboard) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = storyboard.scenes.findIndex((s) => s.id === active.id);
    const newIdx = storyboard.scenes.findIndex((s) => s.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(storyboard.scenes, oldIdx, newIdx).map((s, idx) => ({ ...s, position: idx }));
    const updated: Storyboard = { ...storyboard, scenes: reordered };
    setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    try {
      const res = await fetch(`/api/storyboards/${storyboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updated }),
      });
      if (!res.ok) {
        setStoryboards((prev) => prev.map((s) => s.id === storyboard.id ? storyboard : s));
      }
    } catch {
      setStoryboards((prev) => prev.map((s) => s.id === storyboard.id ? storyboard : s));
    }
  }

  async function handleQuickGenerateScene(scene: StoryboardScene) {
    if (!project) return;
    if (inFlightScenes.has(scene.id)) return;

    const sceneIndex = scene.position;

    // Resolve starting frame: keyframe (this scene) > previous scene's canonical clip > t2v
    let startImageB64: string | undefined;
    let mode: 't2v' | 'i2v' = 't2v';

    const canonicalKeyframeId = resolveCanonicalKeyframeId(scene, clips);
    if (canonicalKeyframeId) {
      // Priority: this scene's canonical keyframe
      const keyframeClip = clips.find((c) => c.id === canonicalKeyframeId);
      if (keyframeClip) {
        try {
          startImageB64 = await encodeImageToBase64(imgSrc(keyframeClip.filePath));
          mode = 'i2v';
        } catch (err) {
          console.warn('[quick-generate] keyframe load failed, checking prev scene clip:', err);
        }
      }
    }

    if (!startImageB64) {
      // Fallback: previous scene's canonical clip's last frame
      let suggestedStartingClipId: string | null = null;
      if (storyboard && sceneIndex > 0) {
        const prevScene = storyboard.scenes[sceneIndex - 1];
        if (prevScene) {
          suggestedStartingClipId = resolveCanonicalClipId(prevScene, clips);
        }
      }

      if (suggestedStartingClipId) {
        const startClip = clips.find((c) => c.id === suggestedStartingClipId);
        if (startClip) {
          try {
            if (startClip.mediaType === 'image') {
              startImageB64 = await encodeImageToBase64(imgSrc(startClip.filePath));
              mode = 'i2v';
            } else {
              const extractRes = await fetch('/api/extract-last-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ generationId: suggestedStartingClipId }),
              });
              if (extractRes.ok) {
                const { frameB64 } = await extractRes.json() as { frameB64: string };
                startImageB64 = frameB64;
                mode = 'i2v';
              } else {
                console.warn('[quick-generate] extract-last-frame failed, falling back to t2v');
                setQuickGenerateError({ sceneId: scene.id, message: "Starting frame couldn't load, generating without it" });
              }
            }
          } catch (err) {
            console.warn('[quick-generate] starting frame extraction failed:', err);
            setQuickGenerateError({ sceneId: scene.id, message: "Starting frame couldn't load, generating without it" });
          }
        }
      }
    }

    const frames = clampToValidFrameCount(scene.durationSeconds * 16);
    const requestBody: Record<string, unknown> = {
      mode,
      prompt: scene.positivePrompt,
      width: project.defaultWidth ?? 1280,
      height: project.defaultHeight ?? 704,
      frames,
      steps: 4,
      cfg: 1,
      seed: -1,
      lightning: true,
      loras: project.defaultVideoLoras ?? [],
      projectId: project.id,
      sceneId: scene.id,
      batchSize: 1,
    };
    if (startImageB64) requestBody.startImageB64 = startImageB64;

    let promptId: string;
    try {
      const res = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No SSE body');
      promptId = await readInitEvent(res.body);
    } catch (err) {
      setQuickGenerateError({ sceneId: scene.id, message: String(err) });
      return;
    }

    const startedAt = Date.now();
    addJob({
      promptId,
      generationId: '',
      mediaType: 'video',
      promptSummary: `Scene ${scene.position + 1}: ${scene.description.slice(0, 40)}`,
      startedAt,
      runningSince: null,
      progress: null,
      status: 'queued',
    });
    setInFlightScenes((prev) => new Map(prev).set(scene.id, { startedAt, promptId }));
  }

  async function handleGenerateKeyframe(scene: StoryboardScene) {
    if (!project) return;
    if (inFlightKeyframeScenes.has(scene.id)) return;

    const checkpoint =
      project.defaultCheckpoint ??
      readLastUsedImageCheckpoint() ??
      modelLists.checkpoints[0] ??
      null;
    if (!checkpoint) {
      setKeyframeError({ sceneId: scene.id, message: 'No image checkpoint available. Add one in the Models tab or set a project default in Settings.' });
      return;
    }

    setInFlightKeyframeScenes((prev) => new Map(prev).set(scene.id, { startedAt: Date.now(), promptId: '' }));
    setKeyframeError(null);

    const params = {
      checkpoint,
      loras: [],
      positivePrompt: scene.positivePrompt,
      negativePrompt: '',
      width: project.defaultWidth ?? 1280,
      height: project.defaultHeight ?? 704,
      steps: 25,
      cfg: 7,
      sampler: 'euler',
      scheduler: 'normal',
      seed: -1,
      batchSize: 1,
      highResFix: false,
      projectId: project.id,
      sceneId: scene.id,
    };

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No SSE body');

      const promptId = await readInitEvent(res.body);
      setInFlightKeyframeScenes((prev) => {
        const next = new Map(prev);
        next.set(scene.id, { startedAt: Date.now(), promptId });
        return next;
      });
      addJob({
        promptId,
        generationId: '',
        mediaType: 'image',
        promptSummary: `Keyframe — Scene ${scene.position + 1}: ${scene.description.slice(0, 40)}`,
        startedAt: Date.now(),
        runningSince: null,
        progress: null,
        status: 'queued',
      });
    } catch (err) {
      setInFlightKeyframeScenes((prev) => {
        const next = new Map(prev);
        next.delete(scene.id);
        return next;
      });
      setKeyframeError({ sceneId: scene.id, message: String(err) });
    }
  }

  async function handleGenerateAllKeyframes() {
    if (!storyboard) return;
    const scenesNeedingKeyframes = storyboard.scenes.filter(
      (s) => resolveCanonicalKeyframeId(s, clips) === null,
    );
    if (scenesNeedingKeyframes.length === 0) return;

    setShowBatchKeyframeConfirm(false);
    setBatchKeyframeScenes(new Set(scenesNeedingKeyframes.map((s) => s.id)));

    for (const scene of scenesNeedingKeyframes) {
      void handleGenerateKeyframe(scene);
    }
  }

  async function clearCanonicalKeyframeIfNeeded(deletedId: string) {
    const affectedSb = storyboards.find((sb) => sb.scenes.some((s) => s.canonicalKeyframeId === deletedId));
    if (!affectedSb) return;
    const updatedScenes = affectedSb.scenes.map((s) =>
      s.canonicalKeyframeId === deletedId ? { ...s, canonicalKeyframeId: null } : s,
    );
    const updatedSb = { ...affectedSb, scenes: updatedScenes };
    setStoryboards((prev) => prev.map((s) => s.id === updatedSb.id ? updatedSb : s));
    void fetch(`/api/storyboards/${affectedSb.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard: updatedSb }),
    }).catch((err) => console.warn('Failed to clear canonicalKeyframeId after delete:', err));
  }

  async function handleDeleteKeyframe(id: string) {
    const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    setClips((prev) => prev.filter((c) => c.id !== id));
    void clearCanonicalKeyframeIfNeeded(id);
  }

  async function handleRegenerateAllKeyframes() {
    if (!storyboard) return;
    setShowRegenerateAllConfirm(false);
    setBatchKeyframeScenes(new Set(storyboard.scenes.map((s) => s.id)));
    for (const scene of storyboard.scenes) {
      void handleGenerateKeyframe(scene);
    }
  }

  async function handlePromoteKeyframeToVideo(keyframe: ProjectClip, scene: StoryboardScene) {
    if (!project) return;

    if (!storyboard?.quickGenerate) {
      // Studio bounce: set keyframe as the i2v starting frame
      const sceneCtx: ProjectContext['sceneContext'] = {
        sceneId: scene.id,
        sceneIndex: scene.position,
        prompt: scene.positivePrompt,
        durationSeconds: scene.durationSeconds,
        suggestedStartingClipId: null,
        suggestedStartingKeyframeId: keyframe.id,
      };
      onGenerateInProject(project, clips[clips.length - 1] ?? null, 'video', sceneCtx);
      return;
    }

    // Inline quick generate using this specific keyframe as starting frame
    if (inFlightScenes.has(scene.id)) return;

    let startImageB64: string | undefined;
    try {
      startImageB64 = await encodeImageToBase64(imgSrc(keyframe.filePath));
    } catch (err) {
      console.warn('[promote-keyframe] Failed to load keyframe image, falling back to t2v:', err);
    }

    const frames = clampToValidFrameCount(scene.durationSeconds * 16);
    const requestBody: Record<string, unknown> = {
      mode: startImageB64 ? 'i2v' : 't2v',
      prompt: scene.positivePrompt,
      width: project.defaultWidth ?? 1280,
      height: project.defaultHeight ?? 704,
      frames,
      steps: 4,
      cfg: 1,
      seed: -1,
      lightning: true,
      loras: project.defaultVideoLoras ?? [],
      projectId: project.id,
      sceneId: scene.id,
      batchSize: 1,
    };
    if (startImageB64) requestBody.startImageB64 = startImageB64;

    let promptId: string;
    try {
      const res = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('No SSE body');
      promptId = await readInitEvent(res.body);
    } catch (err) {
      setQuickGenerateError({ sceneId: scene.id, message: String(err) });
      return;
    }

    const startedAt = Date.now();
    addJob({
      promptId,
      generationId: '',
      mediaType: 'video',
      promptSummary: `Scene ${scene.position + 1}: ${scene.description.slice(0, 40)}`,
      startedAt,
      runningSince: null,
      progress: null,
      status: 'queued',
    });
    setInFlightScenes((prev) => new Map(prev).set(scene.id, { startedAt, promptId }));
  }

  function handleGenerateScene(scene: StoryboardScene) {
    if (storyboard?.quickGenerate) {
      void handleQuickGenerateScene(scene);
      return;
    }
    // Studio bounce path (Phase 5b behavior)
    if (!project) return;
    const sceneIndex = scene.position;

    // Keyframe (this scene) takes priority; fall back to previous scene's canonical clip
    const suggestedStartingKeyframeId = resolveCanonicalKeyframeId(scene, clips);
    let suggestedStartingClipId: string | null = null;
    if (!suggestedStartingKeyframeId && storyboard && sceneIndex > 0) {
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
      suggestedStartingKeyframeId,
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

  // Canonical clips in scene order (for Play canonical / Stitch canonical)
  const canonicalClipsInSceneOrder = storyboard
    ? storyboard.scenes
        .map((s) => resolveCanonicalClipId(s, clips))
        .filter((id): id is string => id !== null)
        .map((id) => clips.find((c) => c.id === id))
        .filter((c): c is ProjectClip => c !== undefined && c.mediaType === 'video')
    : [];
  const canPlayCanonical = canonicalClipsInSceneOrder.length >= 2;
  const canStitchCanonical = canonicalClipsInSceneOrder.length >= 2;

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
        {/* Collapsible header row */}
        <div className="w-full flex items-center justify-between gap-2 min-h-10">
          <button
            onClick={() => setStoryboardExpanded((v) => !v)}
            className="flex items-center gap-2 group flex-1 text-left py-1"
          >
            <span className="text-base">📓</span>
            <span className="text-sm font-semibold text-zinc-200">Storyboard</span>
            {storyboard && (
              <span className="text-xs text-zinc-500">
                {storyboard.scenes.length} scene{storyboard.scenes.length !== 1 ? 's' : ''}
                {' · '}
                {new Date(storyboard.generatedAt).toLocaleDateString()}
              </span>
            )}
          </button>
          <div className="flex items-center gap-1">
            {storyboard && (
              <>
                {/* Quick generate toggle */}
                <button
                  type="button"
                  onClick={() => { void handleQuickGenerateToggle(); }}
                  className="flex items-center gap-1.5 min-h-12 px-2 rounded-lg hover:bg-zinc-800 transition-colors"
                  title="Generate scenes inline with Lightning. Toggle off to fine-tune in Studio."
                >
                  <span className="text-xs text-zinc-400">⚡ Quick</span>
                  <div className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${storyboard.quickGenerate ? 'bg-amber-500' : 'bg-zinc-600'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${storyboard.quickGenerate ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                </button>
                {/* Compact toggle */}
                <button
                  type="button"
                  onClick={() => setCompactMode((v) => !v)}
                  className="flex items-center gap-1.5 min-h-12 px-2 rounded-lg hover:bg-zinc-800 transition-colors"
                  title="Compact view — description only"
                >
                  <span className="text-xs text-zinc-400">📋 Compact</span>
                  <div className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${compactMode ? 'bg-violet-500' : 'bg-zinc-600'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${compactMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                </button>
              </>
            )}
            <button
              onClick={() => setStoryboardExpanded((v) => !v)}
              className="min-h-12 min-w-10 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <svg className={`w-4 h-4 text-zinc-500 transition-transform ${storyboardExpanded ? '' : '-rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {storyboardExpanded && (
          <div className="mt-3 space-y-3">
            {/* Tab strip */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {storyboards.map((sb) => (
                <div key={sb.id} className="relative flex-shrink-0">
                  {renamingStoryboardId === sb.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void handleRenameStoryboard()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void handleRenameStoryboard(); }
                        if (e.key === 'Escape') { setRenamingStoryboardId(null); }
                      }}
                      className="min-h-10 px-3 rounded-lg bg-zinc-800 border border-violet-500 text-sm text-zinc-100 outline-none w-36"
                      autoFocus
                      disabled={renameSaving}
                    />
                  ) : (
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => { setSelectedStoryboardId(sb.id); setTabMenuStoryboardId(null); }}
                        onContextMenu={(e) => { e.preventDefault(); setTabMenuStoryboardId(sb.id); }}
                        className={`min-h-10 px-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap
                          ${selectedStoryboardId === sb.id
                            ? 'bg-violet-600/20 border border-violet-600/40 text-violet-300 rounded-r-none border-r-0'
                            : 'bg-zinc-800/60 border border-zinc-700/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
                      >
                        {sb.name}
                      </button>
                      {selectedStoryboardId === sb.id && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (tabMenuStoryboardId === sb.id) {
                              setTabMenuStoryboardId(null);
                              setTabMenuPos(null);
                            } else {
                              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                              setTabMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                              setTabMenuStoryboardId(sb.id);
                            }
                          }}
                          className="min-h-10 min-w-8 flex items-center justify-center rounded-lg rounded-l-none bg-violet-600/20 border border-violet-600/40 border-l-0 text-violet-400 hover:text-violet-200 transition-colors"
                          title="Storyboard options"
                        >
                          ⋮
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {/* + tab */}
              <button
                type="button"
                onClick={() => { setNewStoryboardName(''); setShowCreateStoryboardModal(true); }}
                className="min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-zinc-800/60 border border-zinc-700/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors flex-shrink-0"
                title="Create new storyboard"
              >
                +
              </button>
            </div>

            {/* Storyboard tab context menu — fixed to avoid overflow-x-auto clipping */}
            {tabMenuStoryboardId && tabMenuPos && tabMenuStoryboard && (
              <div
                className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl overflow-hidden min-w-40"
                style={{ top: tabMenuPos.top, right: tabMenuPos.right }}
              >
                <button
                  type="button"
                  onClick={() => { setTabMenuStoryboardId(null); setTabMenuPos(null); setRenamingStoryboardId(tabMenuStoryboard.id); setRenameValue(tabMenuStoryboard.name); }}
                  className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-800 min-h-12"
                >Rename</button>
                <button
                  type="button"
                  onClick={() => { setTabMenuStoryboardId(null); setTabMenuPos(null); setSelectedStoryboardId(tabMenuStoryboard.id); setShowStoryboardDeleteConfirm(true); }}
                  className="w-full text-left px-4 py-3 text-sm text-red-400 hover:bg-zinc-800 min-h-12"
                >Delete</button>
              </div>
            )}
            {/* Close tab menu on outside click */}
            {tabMenuStoryboardId && (
              <div className="fixed inset-0 z-40" onClick={() => { setTabMenuStoryboardId(null); setTabMenuPos(null); }} />
            )}

            {/* Content area */}
            {storyboards.length === 0 ? (
              /* No storyboards at all */
              <div className="rounded-xl border border-dashed border-zinc-700 p-5 text-center space-y-3">
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Plan your project with AI. Describe a story idea and generate a scene-by-scene outline.
                </p>
                <button
                  type="button"
                  onClick={() => setShowStoryboardModal(true)}
                  className="min-h-12 px-5 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 hover:border-violet-600/50 text-violet-300 text-sm font-medium transition-colors"
                >
                  + Plan with AI
                </button>
              </div>
            ) : !storyboard ? null : storyboard.scenes.length === 0 ? (
              /* Have a storyboard but no scenes yet */
              <div className="rounded-xl border border-dashed border-zinc-700 p-5 text-center space-y-3">
                <p className="text-sm text-zinc-400">This storyboard has no scenes yet.</p>
                <div className="flex gap-2 justify-center">
                  <button
                    type="button"
                    onClick={() => setShowStoryboardModal(true)}
                    className="min-h-12 px-4 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 text-violet-300 text-sm font-medium transition-colors"
                  >
                    Plan with AI
                  </button>
                  <button
                    type="button"
                    onClick={() => { setInsertAtPosition(0); setEditingScene(null); }}
                    className="min-h-12 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
                  >
                    + Add scene manually
                  </button>
                </div>
              </div>
            ) : (
              /* Populated scenes */
              <div className="space-y-2">
                {/* Play canonical / Stitch canonical buttons */}
                {(canPlayCanonical || canStitchCanonical) && (
                  <div className="flex gap-2 pb-1">
                    {canPlayCanonical && (
                      <button
                        type="button"
                        onClick={() => {
                          setPlayThrough(false);
                          setPlayCanonical((v) => !v);
                          if (!playCanonical) { setPlayingCanonicalIdx(0); setPlayCanonicalDone(false); }
                        }}
                        className={`flex-1 min-h-12 rounded-xl text-sm font-medium border transition-colors flex items-center justify-center gap-2
                          ${playCanonical
                            ? 'bg-violet-600/20 border-violet-600/30 text-violet-300'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}`}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                        </svg>
                        {playCanonical ? 'Stop' : '▶ Play canonical'}
                      </button>
                    )}
                    {canStitchCanonical && (
                      <button
                        type="button"
                        onClick={() => {
                          setCanonicalStitchClipIds(canonicalClipsInSceneOrder.map((c) => c.id));
                          setCanonicalStitchStoryboardId(storyboard?.id ?? null);
                          setShowStitch(true);
                        }}
                        className="flex-1 min-h-12 rounded-xl border border-emerald-600/30 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-300 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        🪡 Stitch canonical
                      </button>
                    )}
                  </div>
                )}

                {/* Play canonical view */}
                {playCanonical && (
                  <div className="rounded-xl bg-zinc-800/60 overflow-hidden">
                    {!playCanonicalDone ? (
                      /* eslint-disable-next-line jsx-a11y/media-has-caption */
                      <video
                        ref={canonicalPlayerRef}
                        src={imgSrc(canonicalClipsInSceneOrder[playingCanonicalIdx]?.filePath ?? '')}
                        autoPlay
                        playsInline
                        controls
                        onEnded={() => {
                          if (playingCanonicalIdx < canonicalClipsInSceneOrder.length - 1) {
                            setPlayingCanonicalIdx((i) => i + 1);
                          } else {
                            setPlayCanonicalDone(true);
                          }
                        }}
                        className="w-full aspect-video bg-black"
                      />
                    ) : (
                      <div className="aspect-video flex flex-col items-center justify-center gap-3">
                        <p className="text-sm text-zinc-400">All scenes played</p>
                        <button
                          onClick={() => { setPlayingCanonicalIdx(0); setPlayCanonicalDone(false); }}
                          className="min-h-12 px-4 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm font-medium"
                        >
                          Play again
                        </button>
                      </div>
                    )}
                    {/* Scene chips */}
                    <div className="flex gap-1.5 px-3 py-2 overflow-x-auto">
                      {canonicalClipsInSceneOrder.map((_, idx) => {
                        const scenesWithCanonical = storyboard.scenes.filter((s) => resolveCanonicalClipId(s, clips) !== null);
                        const sceneForChip = scenesWithCanonical[idx];
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => { setPlayingCanonicalIdx(idx); setPlayCanonicalDone(false); }}
                            className={`flex-shrink-0 min-h-8 px-2.5 rounded-lg text-xs font-medium transition-colors
                              ${playingCanonicalIdx === idx
                                ? 'bg-violet-600 text-white'
                                : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                          >
                            Scene {sceneForChip ? storyboard.scenes.indexOf(sceneForChip) + 1 : idx + 1}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Scene list with drag-to-reorder */}
                {!playCanonical && (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleSceneDragEnd}
                  >
                    <SortableContext
                      items={storyboard.scenes.map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
                        {/* Insert above first scene (non-compact only) */}
                        {!compactMode && (
                          <button
                            type="button"
                            onClick={() => { setInsertAtPosition(0); setEditingScene(null); }}
                            className="w-full h-6 flex items-center justify-center rounded-lg border border-dashed border-zinc-700/50 text-zinc-600 hover:text-zinc-400 hover:border-zinc-600 text-xs transition-colors"
                          >
                            + Insert scene here
                          </button>
                        )}
                        {storyboard.scenes.map((scene, i) => {
                          const sceneAllClips = clips.filter((c) => c.sceneId === scene.id);
                          const sceneClips = sceneAllClips.filter((c) => c.mediaType === 'video');
                          const sceneKeyframes = sceneAllClips.filter((c) => c.mediaType === 'image');
                          const canonicalId = resolveCanonicalClipId(scene, clips);
                          const canonicalClip = canonicalId ? clips.find((c) => c.id === canonicalId) ?? null : null;
                          const canonicalKfId = resolveCanonicalKeyframeId(scene, clips);
                          const canonicalKeyframe = canonicalKfId ? clips.find((c) => c.id === canonicalKfId) ?? null : null;

                          return (
                            <div key={scene.id}>
                              <SortableSceneCard
                                scene={scene}
                                sceneIndex={i}
                                sceneClips={sceneClips}
                                canonicalClip={canonicalClip}
                                canonicalId={canonicalId}
                                sceneKeyframes={sceneKeyframes}
                                canonicalKeyframe={canonicalKeyframe}
                                canonicalKeyframeId={canonicalKfId}
                                compactMode={compactMode}
                                showFull={!compactMode || expandedSceneIds.has(scene.id)}
                                isInFlight={inFlightScenes.has(scene.id)}
                                inFlightEntry={inFlightScenes.get(scene.id)}
                                isKeyframeInFlight={inFlightKeyframeScenes.has(scene.id)}
                                keyframeInFlightEntry={inFlightKeyframeScenes.get(scene.id)}
                                nowTick={nowTick}
                                quickGenerateError={quickGenerateError}
                                keyframeError={keyframeError}
                                onExpand={() => setExpandedSceneIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(scene.id)) next.delete(scene.id); else next.add(scene.id);
                                  return next;
                                })}
                                onEdit={() => { setInsertAtPosition(null); setEditingScene(scene); }}
                                onGenerate={() => handleGenerateScene(scene)}
                                onGenerateKeyframe={() => { void handleGenerateKeyframe(scene); }}
                                onOpenClips={() => {
                                  if (sceneClips.length === 1) {
                                    setModalIdx(getModalIndexById(sceneClips[0].id));
                                  } else {
                                    setCanonicalPickerScene(scene);
                                  }
                                }}
                                onOpenCanonical={() => {
                                  if (canonicalClip) setModalIdx(getModalIndexById(canonicalClip.id));
                                }}
                                onOpenKeyframes={() => {
                                  if (sceneKeyframes.length === 1) {
                                    setModalIdx(getModalIndexById(sceneKeyframes[0].id));
                                  } else {
                                    setCanonicalKeyframePickerScene(scene);
                                  }
                                }}
                                onOpenCanonicalKeyframe={() => {
                                  if (canonicalKeyframe) setModalIdx(getModalIndexById(canonicalKeyframe.id));
                                  else setCanonicalKeyframePickerScene(scene);
                                }}
                                onDismissError={() => setQuickGenerateError(null)}
                                onDismissKeyframeError={() => setKeyframeError(null)}
                              />
                              {/* Insert between scenes (non-compact only) */}
                              {!compactMode && (
                                <button
                                  type="button"
                                  onClick={() => { setInsertAtPosition(i + 1); setEditingScene(null); }}
                                  className="w-full h-6 flex items-center justify-center rounded-lg border border-dashed border-zinc-700/50 text-zinc-600 hover:text-zinc-400 hover:border-zinc-600 text-xs transition-colors mt-1.5"
                                >
                                  + Insert scene here
                                </button>
                              )}
                            </div>
                          );
                        })}

                        {/* Add scene at end (compact mode) */}
                        {compactMode && (
                          <button
                            type="button"
                            onClick={() => { setInsertAtPosition(storyboard.scenes.length); setEditingScene(null); }}
                            className="w-full min-h-12 rounded-xl bg-zinc-800/40 border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 text-sm transition-colors"
                          >
                            + Add scene
                          </button>
                        )}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}

                {/* Batch keyframe generation */}
                {(() => {
                  const scenesNeedingKeyframes = storyboard.scenes.filter(
                    (s) => resolveCanonicalKeyframeId(s, clips) === null,
                  );
                  const anyCanonicalExists = storyboard.scenes.some(
                    (s) => resolveCanonicalKeyframeId(s, clips) !== null,
                  );
                  const batchTotal = batchKeyframeScenes.size;
                  const batchCompleted = Array.from(batchKeyframeScenes).filter(
                    (id) => !inFlightKeyframeScenes.has(id),
                  ).length;
                  const batchInProgress = batchTotal > 0 && batchCompleted < batchTotal;

                  if (scenesNeedingKeyframes.length === 0 && !anyCanonicalExists && !batchInProgress) return null;

                  return (
                    <div className="space-y-2">
                      {batchInProgress ? (
                        <div className="w-full min-h-12 rounded-xl bg-sky-600/15 border border-sky-600/25 text-sky-300 text-sm font-medium flex items-center justify-center gap-2 px-4">
                          <svg className="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Generating keyframes ({batchCompleted}/{batchTotal})
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          {scenesNeedingKeyframes.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setShowBatchKeyframeConfirm(true)}
                              className="flex-1 min-h-12 rounded-xl bg-sky-600/15 hover:bg-sky-600/25 border border-sky-600/25 hover:border-sky-600/45 text-sky-300 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                            >
                              🖼 Generate keyframes ({scenesNeedingKeyframes.length} needed)
                            </button>
                          )}
                          {anyCanonicalExists && (
                            <button
                              type="button"
                              onClick={() => setShowRegenerateAllConfirm(true)}
                              className={`${scenesNeedingKeyframes.length > 0 ? 'min-w-[9.5rem]' : 'flex-1'} min-h-12 px-3 rounded-xl bg-zinc-700/60 hover:bg-zinc-700 border border-zinc-600/40 text-zinc-300 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap`}
                            >
                              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Regenerate all
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Storyboard actions */}
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
            void clearCanonicalKeyframeIfNeeded(id);
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
          onPromoteToVideo={(record) => {
            if (!storyboard || !record.sceneId || record.mediaType !== 'image') return;
            const scene = storyboard.scenes.find((s) => s.id === record.sceneId);
            if (!scene) return;
            const keyframe = clips.find((c) => c.id === record.id);
            if (!keyframe) return;
            setModalIdx(null);
            void handlePromoteKeyframeToVideo(keyframe, scene);
          }}
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
          initialClipIds={canonicalStitchClipIds.length > 0 ? canonicalStitchClipIds : undefined}
          storyboardId={canonicalStitchStoryboardId ?? undefined}
          onClose={() => { setShowStitch(false); setCanonicalStitchClipIds([]); setCanonicalStitchStoryboardId(null); }}
          onStitched={(export_) => {
            // Prepend to stitchedExports — the new stitch becomes the most recent
            setStitchedExports((prev) => [export_, ...prev]);
            setShowStitch(false);
            setCanonicalStitchClipIds([]);
            setCanonicalStitchStoryboardId(null);
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
          targetStoryboardId={storyboard?.id ?? null}
          targetStoryboard={storyboard ?? undefined}
          onClose={() => setShowStoryboardModal(false)}
          onSaved={(sb) => {
            setStoryboards((prev) => {
              const exists = prev.find((s) => s.id === sb.id);
              if (exists) return prev.map((s) => s.id === sb.id ? sb : s);
              return [...prev, sb];
            });
            setSelectedStoryboardId(sb.id);
            setStoryboardExpanded(true);
          }}
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
      {(editingScene !== null || insertAtPosition !== null) && storyboard && (
        <SceneEditModal
          scene={editingScene}
          insertAtPosition={insertAtPosition ?? undefined}
          sceneIndex={editingScene ? storyboard.scenes.indexOf(editingScene) : (insertAtPosition ?? storyboard.scenes.length)}
          totalScenes={storyboard.scenes.length}
          storyboard={storyboard}
          onClose={() => { setEditingScene(null); setInsertAtPosition(null); }}
          onSaved={(updated) => {
            setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s));
            setEditingScene(null);
            setInsertAtPosition(null);
          }}
        />
      )}

      {/* ── Create storyboard modal ── */}
      {showCreateStoryboardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCreateStoryboardModal(false)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-zinc-100">New storyboard</h3>
            <input
              type="text"
              value={newStoryboardName}
              onChange={(e) => setNewStoryboardName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateStoryboard(); if (e.key === 'Escape') setShowCreateStoryboardModal(false); }}
              className="input-base w-full"
              placeholder={`Storyboard ${storyboards.length + 1}`}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={() => setShowCreateStoryboardModal(false)} className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors">Cancel</button>
              <button onClick={() => void handleCreateStoryboard()} disabled={creatingStoryboard} className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors disabled:opacity-50">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Canonical clip picker ── */}
      {canonicalPickerScene && storyboard && (
        <CanonicalClipPickerModal
          scene={canonicalPickerScene}
          sceneIndex={storyboard.scenes.indexOf(canonicalPickerScene)}
          sceneClips={clips.filter((c) => c.sceneId === canonicalPickerScene.id)}
          allProjectClips={clips}
          canonicalClipId={resolveCanonicalClipId(canonicalPickerScene, clips)}
          projectId={projectId}
          projectName={project?.name ?? ''}
          storyboard={storyboard}
          onClose={() => setCanonicalPickerScene(null)}
          onCanonicalChanged={(updated) => setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s))}
          onClipAttached={() => void load()}
        />
      )}

      {/* ── Canonical keyframe picker ── */}
      {canonicalKeyframePickerScene && storyboard && (
        <CanonicalKeyframePickerModal
          scene={canonicalKeyframePickerScene}
          sceneIndex={storyboard.scenes.indexOf(canonicalKeyframePickerScene)}
          sceneKeyframes={clips.filter((c) => c.sceneId === canonicalKeyframePickerScene.id && c.mediaType === 'image')}
          canonicalKeyframeId={resolveCanonicalKeyframeId(canonicalKeyframePickerScene, clips)}
          projectId={projectId}
          projectName={project?.name ?? ''}
          storyboard={storyboard}
          onClose={() => setCanonicalKeyframePickerScene(null)}
          onCanonicalChanged={(updated) => setStoryboards((prev) => prev.map((s) => s.id === updated.id ? updated : s))}
          onGenerateKeyframe={(scene) => { void handleGenerateKeyframe(scene); }}
          onPromoteToVideo={(keyframe, scene) => { void handlePromoteKeyframeToVideo(keyframe, scene); }}
          onOpenModal={(id) => setModalIdx(getModalIndexById(id))}
          onDeleteKeyframe={handleDeleteKeyframe}
        />
      )}

      {/* ── Regenerate all keyframes confirm dialog ── */}
      {showRegenerateAllConfirm && storyboard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={() => setShowRegenerateAllConfirm(false)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-zinc-100">Regenerate keyframes for all {storyboard.scenes.length} scenes?</h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              This will queue {storyboard.scenes.length} image generation{storyboard.scenes.length !== 1 ? 's' : ''} on the GPU.
              Existing keyframes are preserved as non-canonical alternates — new ones become canonical automatically.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowRegenerateAllConfirm(false)}
                className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void handleRegenerateAllKeyframes(); }}
                className="flex-1 min-h-12 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold transition-colors"
              >
                Regenerate all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Batch keyframe confirm dialog ── */}
      {showBatchKeyframeConfirm && storyboard && (() => {
        const scenesNeedingKeyframes = storyboard.scenes.filter(
          (s) => resolveCanonicalKeyframeId(s, clips) === null,
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={() => setShowBatchKeyframeConfirm(false)}>
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-base font-semibold text-zinc-100">Generate keyframes for {scenesNeedingKeyframes.length} scene{scenesNeedingKeyframes.length !== 1 ? 's' : ''}?</h2>
              <p className="text-sm text-zinc-400 leading-relaxed">
                This will queue {scenesNeedingKeyframes.length} image generation{scenesNeedingKeyframes.length !== 1 ? 's' : ''} on the GPU.
                They&apos;ll run in sequence and complete in roughly {Math.ceil(scenesNeedingKeyframes.length * 0.5)} minutes.
                You can keep using the app while they generate.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowBatchKeyframeConfirm(false)}
                  className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { void handleGenerateAllKeyframes(); }}
                  className="flex-1 min-h-12 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold transition-colors"
                >
                  Generate
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
