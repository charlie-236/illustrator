'use client';

import { useState, useEffect } from 'react';
import type { ProjectClip, StoryboardScene, Storyboard, GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';
import ImageModal from './ImageModal';
import GalleryPicker from './GalleryPicker';

interface Props {
  scene: StoryboardScene;
  sceneIndex: number;
  sceneClips: ProjectClip[];
  /** All video clips in the project (for "Pick from project" sub-picker) */
  allProjectClips: ProjectClip[];
  canonicalClipId: string | null;
  projectId: string;
  projectName: string;
  storyboard: Storyboard;
  onClose: () => void;
  onCanonicalChanged: (updated: Storyboard) => void;
}

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
    projectId,
    projectName,
    isStitched: false,
    parentProjectId: null,
    parentProjectName: null,
    stitchedClipIds: null,
    videoLorasJson: null,
    lightning: null,
    sceneId: clip.sceneId,
    createdAt: clip.createdAt,
  };
}

export default function CanonicalClipPickerModal({
  scene,
  sceneIndex,
  sceneClips,
  allProjectClips,
  canonicalClipId,
  projectId,
  projectName,
  storyboard,
  onClose,
  onCanonicalChanged,
}: Props) {
  const [localCanonicalId, setLocalCanonicalId] = useState<string | null>(canonicalClipId);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipModalIdx, setClipModalIdx] = useState<number | null>(null);

  // Sub-pickers for "Attach existing"
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);

  const clipRecords = sceneClips.map((c) => clipToRecord(c, projectId, projectName));
  const projectVideoClips = allProjectClips.filter((c) => c.mediaType === 'video' && !c.isStitched);

  async function saveCanonical(clipId: string | null, sceneId: string | null, clipGenerationId?: string) {
    setError(null);

    const updatedScenes = storyboard.scenes.map((s) =>
      s.id === scene.id ? { ...s, canonicalClipId: clipId } : s,
    );
    const updatedStoryboard: Storyboard = { ...storyboard, scenes: updatedScenes };

    try {
      // Save canonical on storyboard
      const res = await fetch(`/api/storyboards/${storyboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updatedStoryboard }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Failed to save');
        return;
      }

      // If attaching from outside: write sceneId on the generation
      if (clipGenerationId && sceneId) {
        await fetch(`/api/generations/${clipGenerationId}/scene`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId }),
        });
      }

      setLocalCanonicalId(clipId);
      onCanonicalChanged(updatedStoryboard);
    } catch {
      setError('Network error');
    }
  }

  async function handleSetCanonical(clipId: string) {
    if (clipId === localCanonicalId) return;
    setSettingId(clipId);
    await saveCanonical(clipId, null);
    setSettingId(null);
  }

  async function handleDetach() {
    setSettingId('detaching');
    // Clear canonicalClipId on storyboard (sceneId on the clip stays — non-destructive)
    await saveCanonical(null, null);
    setSettingId(null);
  }

  async function handleAttachProjectClip(clip: ProjectClip) {
    setShowProjectPicker(false);
    setSettingId(clip.id);
    await saveCanonical(clip.id, scene.id, clip.id);
    setSettingId(null);
  }

  async function handleAttachGalleryClip(record: GenerationRecord) {
    setShowGalleryPicker(false);
    setSettingId(record.id);
    await saveCanonical(record.id, scene.id, record.id);
    setSettingId(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Canonical clip — Scene {sceneIndex + 1}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Pick which clip should chain into the next scene&apos;s starting frame.
            </p>
          </div>
          <button
            onClick={onClose}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Clips generated from this scene */}
          <div className="space-y-3">
            <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
              Clips generated from this scene
            </p>
            {sceneClips.length === 0 ? (
              <p className="text-sm text-zinc-500 text-center py-4">No clips generated for this scene yet.</p>
            ) : (
              sceneClips.map((clip, i) => {
                const isCanonical = clip.id === localCanonicalId;
                const isSettingThis = settingId === clip.id;
                const durationSec = clip.fps > 0 ? (clip.frames / clip.fps).toFixed(1) : null;

                return (
                  <div
                    key={clip.id}
                    className={`rounded-xl border overflow-hidden transition-colors ${
                      isCanonical
                        ? 'border-violet-600/60 bg-violet-600/5'
                        : 'border-zinc-700 bg-zinc-800/40'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setClipModalIdx(i)}
                      className="w-full block relative"
                    >
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        src={imgSrc(clip.filePath)}
                        preload="metadata"
                        muted
                        playsInline
                        className="w-full aspect-video object-cover bg-zinc-800"
                      />
                      {isCanonical && (
                        <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-violet-600/90 text-white text-xs font-semibold">
                          Canonical
                        </div>
                      )}
                    </button>

                    <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                      <p className="text-xs text-zinc-400">
                        {new Date(clip.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        {durationSec ? ` · ${durationSec}s` : ''}
                      </p>
                      <div className="flex gap-2 flex-shrink-0">
                        {isCanonical && (
                          <button
                            type="button"
                            onClick={() => void handleDetach()}
                            disabled={settingId !== null}
                            className="min-h-10 px-3 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-60 disabled:pointer-events-none"
                          >
                            Detach
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleSetCanonical(clip.id)}
                          disabled={isCanonical || isSettingThis || settingId !== null}
                          className={`min-h-10 px-3 rounded-lg text-xs font-medium transition-colors
                            ${isCanonical
                              ? 'bg-violet-600/20 text-violet-300 cursor-default'
                              : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                            } disabled:opacity-60 disabled:pointer-events-none`}
                        >
                          {isSettingThis ? 'Saving…' : isCanonical ? 'Canonical' : 'Set as canonical'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Divider + Attach existing */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">Or attach an existing clip</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowProjectPicker(true)}
                disabled={settingId !== null}
                className="flex-1 min-h-12 rounded-xl border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Pick from project
              </button>
              <button
                type="button"
                onClick={() => setShowGalleryPicker(true)}
                disabled={settingId !== null}
                className="flex-1 min-h-12 rounded-xl border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Pick from gallery
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 pt-3 border-t border-zinc-800 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {/* Clip detail modal */}
      {clipModalIdx !== null && (
        <ImageModal
          items={clipRecords}
          startIndex={clipModalIdx}
          onClose={() => setClipModalIdx(null)}
          onRemix={() => {}}
          onDelete={async () => {}}
          storyboard={storyboard}
        />
      )}

      {/* Pick from project sub-modal */}
      {showProjectPicker && (
        <div
          className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setShowProjectPicker(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
              <h3 className="text-base font-semibold text-zinc-100">Pick from project</h3>
              <button
                onClick={() => setShowProjectPicker(false)}
                className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {projectVideoClips.length === 0 ? (
                <p className="text-sm text-zinc-500 text-center py-6">No video clips in this project yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {projectVideoClips.map((clip) => {
                    const isCurrentCanonical = clip.id === localCanonicalId;
                    return (
                      <button
                        key={clip.id}
                        type="button"
                        onClick={() => void handleAttachProjectClip(clip)}
                        className={`relative rounded-xl overflow-hidden border transition-colors text-left
                          ${isCurrentCanonical
                            ? 'border-violet-600/60 opacity-60 pointer-events-none'
                            : 'border-zinc-700 hover:border-violet-500'}`}
                      >
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <video
                          src={imgSrc(clip.filePath)}
                          preload="metadata"
                          muted
                          playsInline
                          className="w-full aspect-video object-cover bg-zinc-800"
                        />
                        {isCurrentCanonical && (
                          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-violet-600/90 text-white text-xs font-semibold">
                            Current
                          </div>
                        )}
                        <div className="px-2 py-1.5">
                          <p className="text-xs text-zinc-400 truncate">{clip.prompt.slice(0, 40) || '(no prompt)'}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pick from gallery — uses GalleryPicker with video filter */}
      {showGalleryPicker && (
        <GalleryPickerVideoAdapter
          onClose={() => setShowGalleryPicker(false)}
          onSelect={(record) => void handleAttachGalleryClip(record)}
        />
      )}
    </div>
  );
}

/** Thin wrapper that opens GalleryPicker but resets to video filter */
function GalleryPickerVideoAdapter({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (record: GenerationRecord) => void;
}) {
  return (
    <GalleryPickerVideo open onClose={onClose} onSelect={onSelect} />
  );
}

/** Inline video-filtered gallery picker (avoids modifying GalleryPicker's existing API) */
function GalleryPickerVideo({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (record: GenerationRecord) => void;
}) {
  // Reuse GalleryPicker but it only shows images by default; we render our own video picker
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ mediaType: 'video', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/gallery?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { items: GenerationRecord[]; nextCursor: string | null };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadMore(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
          <h3 className="text-base font-semibold text-zinc-100">Pick from gallery</h3>
          <button
            onClick={onClose}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 && !loading && (
            <p className="text-sm text-zinc-500 text-center py-6">No video clips in gallery.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {items.map((record) => (
              <button
                key={record.id}
                type="button"
                onClick={() => onSelect(record)}
                className="relative rounded-xl overflow-hidden border border-zinc-700 hover:border-violet-500 transition-colors text-left"
              >
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  src={imgSrc(record.filePath)}
                  preload="metadata"
                  muted
                  playsInline
                  className="w-full aspect-video object-cover bg-zinc-800"
                />
                <div className="px-2 py-1.5">
                  <p className="text-xs text-zinc-400 truncate">{record.promptPos.slice(0, 40) || '(no prompt)'}</p>
                </div>
              </button>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
              className="w-full min-h-12 mt-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
