'use client';

import { useState } from 'react';
import type { ProjectClip, StoryboardScene, Storyboard, GenerationRecord } from '@/types';
import { imgSrc } from '@/lib/imageSrc';
import ImageModal from './ImageModal';

interface Props {
  scene: StoryboardScene;
  sceneIndex: number;
  sceneKeyframes: ProjectClip[];
  canonicalKeyframeId: string | null;
  projectId: string;
  projectName: string;
  storyboard: Storyboard;
  onClose: () => void;
  onCanonicalChanged: (updated: Storyboard) => void;
  onGenerateKeyframe: (scene: StoryboardScene) => void;
  onPromoteToVideo: (keyframe: ProjectClip, scene: StoryboardScene) => void;
  onOpenModal: (id: string) => void;
}

function keyframeToRecord(kf: ProjectClip, projectId: string, projectName: string): GenerationRecord {
  return {
    id: kf.id,
    filePath: kf.filePath,
    promptPos: kf.prompt,
    promptNeg: '',
    model: 'unknown',
    lora: null,
    lorasJson: null,
    assembledPos: null,
    assembledNeg: null,
    seed: '0',
    cfg: 7,
    steps: 25,
    width: kf.width,
    height: kf.height,
    sampler: 'euler',
    scheduler: 'normal',
    highResFix: false,
    isFavorite: kf.isFavorite,
    mediaType: 'image',
    frames: null,
    fps: null,
    projectId,
    projectName,
    isStitched: false,
    parentProjectId: null,
    parentProjectName: null,
    stitchedClipIds: null,
    videoLorasJson: null,
    lightning: null,
    sceneId: kf.sceneId,
    storyboardId: null,
    createdAt: kf.createdAt,
  };
}

export default function CanonicalKeyframePickerModal({
  scene,
  sceneIndex,
  sceneKeyframes,
  canonicalKeyframeId,
  projectId,
  projectName,
  storyboard,
  onClose,
  onCanonicalChanged,
  onGenerateKeyframe,
  onPromoteToVideo,
  onOpenModal,
}: Props) {
  const [localCanonicalId, setLocalCanonicalId] = useState<string | null>(canonicalKeyframeId);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kfModalIdx, setKfModalIdx] = useState<number | null>(null);

  const kfRecords = sceneKeyframes.map((kf) => keyframeToRecord(kf, projectId, projectName));

  async function saveCanonical(keyframeId: string | null) {
    setError(null);
    setSettingId(keyframeId ?? '__clear__');

    const updatedScenes = storyboard.scenes.map((s) =>
      s.id === scene.id ? { ...s, canonicalKeyframeId: keyframeId } : s,
    );
    const updatedStoryboard: Storyboard = { ...storyboard, scenes: updatedScenes };

    try {
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
      setLocalCanonicalId(keyframeId);
      onCanonicalChanged(updatedStoryboard);
    } catch (err) {
      setError(String(err));
    } finally {
      setSettingId(null);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                Keyframes — Scene {sceneIndex + 1}
              </h2>
              {scene.description && (
                <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{scene.description}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-4 py-4 space-y-3">
            {error && (
              <p className="text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded-lg px-3 py-2">{error}</p>
            )}

            {sceneKeyframes.length === 0 ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-zinc-400">No keyframes generated for this scene yet.</p>
                <button
                  type="button"
                  onClick={() => { onGenerateKeyframe(scene); onClose(); }}
                  className="min-h-12 px-5 rounded-xl bg-sky-600/20 hover:bg-sky-600/30 border border-sky-600/30 text-sky-300 text-sm font-medium transition-colors"
                >
                  🖼 Generate keyframe
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {sceneKeyframes.map((kf, idx) => {
                  const isCanonical = localCanonicalId === kf.id;
                  const isSetting = settingId === kf.id;
                  return (
                    <div key={kf.id} className={`rounded-xl overflow-hidden border transition-colors ${isCanonical ? 'border-sky-500/60' : 'border-zinc-700'}`}>
                      {/* Thumbnail */}
                      <button
                        type="button"
                        onClick={() => setKfModalIdx(idx)}
                        className="block w-full"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imgSrc(kf.filePath)}
                          alt=""
                          className="w-full aspect-video object-cover bg-zinc-800"
                        />
                      </button>

                      {/* Meta + actions */}
                      <div className="bg-zinc-800/60 px-3 py-2 space-y-2">
                        <div className="flex items-center gap-2">
                          {isCanonical && (
                            <span className="text-xs bg-sky-600/20 border border-sky-600/30 text-sky-300 px-2 py-0.5 rounded-full font-medium">
                              Canonical
                            </span>
                          )}
                          <span className="text-xs text-zinc-500">
                            {new Date(kf.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        <div className="flex gap-2">
                          {!isCanonical && (
                            <button
                              type="button"
                              disabled={!!settingId}
                              onClick={() => { void saveCanonical(kf.id); }}
                              className="flex-1 min-h-10 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-600/30 text-sky-300 text-xs font-medium transition-colors disabled:opacity-50"
                            >
                              {isSetting ? 'Saving…' : 'Set as canonical'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => { onPromoteToVideo(kf, scene); onClose(); }}
                            className="flex-1 min-h-10 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 text-violet-300 text-xs font-medium transition-colors"
                          >
                            <svg className="w-3 h-3 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                            Promote to video
                          </button>
                          <button
                            type="button"
                            onClick={() => { onGenerateKeyframe(scene); onClose(); }}
                            className="min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-zinc-700/60 hover:bg-zinc-700 border border-zinc-600/40 text-zinc-400 hover:text-zinc-200 transition-colors"
                            title="Regenerate keyframe"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Generate another keyframe */}
                <button
                  type="button"
                  onClick={() => { onGenerateKeyframe(scene); onClose(); }}
                  className="w-full min-h-12 rounded-xl bg-sky-600/10 hover:bg-sky-600/20 border border-dashed border-sky-600/30 text-sky-400 text-sm transition-colors"
                >
                  🖼 Generate another keyframe
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Nested ImageModal for viewing keyframes */}
      {kfModalIdx !== null && (
        <div className="fixed inset-0 z-50">
          <ImageModal
            items={kfRecords}
            startIndex={kfModalIdx}
            onClose={() => setKfModalIdx(null)}
            onRemix={() => {}}
            onDelete={async () => {}}
            storyboard={storyboard}
          />
        </div>
      )}
    </>
  );
}
