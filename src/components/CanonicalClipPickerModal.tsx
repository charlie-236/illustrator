'use client';

import { useState } from 'react';
import type { ProjectClip, StoryboardScene, Storyboard, GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';
import ImageModal from './ImageModal';

interface Props {
  scene: StoryboardScene;
  sceneIndex: number;
  sceneClips: ProjectClip[];
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

  const clipRecords = sceneClips.map((c) => clipToRecord(c, projectId, projectName));

  async function handleSetCanonical(clipId: string) {
    if (clipId === localCanonicalId) return;
    setSettingId(clipId);
    setError(null);

    const updatedScenes = storyboard.scenes.map((s) =>
      s.id === scene.id ? { ...s, canonicalClipId: clipId } : s,
    );
    const updatedStoryboard: Storyboard = { ...storyboard, scenes: updatedScenes };

    try {
      const res = await fetch(`/api/projects/${projectId}/storyboard`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: updatedStoryboard }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Failed to save');
        return;
      }
      setLocalCanonicalId(clipId);
      onCanonicalChanged(updatedStoryboard);
    } catch {
      setError('Network error');
    } finally {
      setSettingId(null);
    }
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

        {/* Clip list */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {sceneClips.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">No clips generated for this scene yet.</p>
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
                  {/* Thumbnail — tapping opens the ImageModal */}
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

                  {/* Meta + action */}
                  <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                    <p className="text-xs text-zinc-400">
                      {new Date(clip.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      {durationSec ? ` · ${durationSec}s` : ''}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleSetCanonical(clip.id)}
                      disabled={isCanonical || isSettingThis}
                      className={`min-h-10 px-3 rounded-lg text-xs font-medium transition-colors flex-shrink-0
                        ${isCanonical
                          ? 'bg-violet-600/20 text-violet-300 cursor-default'
                          : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                        } disabled:opacity-60 disabled:pointer-events-none`}
                    >
                      {isSettingThis ? 'Saving…' : isCanonical ? 'Canonical' : 'Set as canonical'}
                    </button>
                  </div>
                </div>
              );
            })
          )}

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

      {/* Clip detail modal — opens on top */}
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
    </div>
  );
}
