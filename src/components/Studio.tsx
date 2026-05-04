'use client';

import { useState, useRef, useEffect } from 'react';
import PromptArea from './PromptArea';
import ModelSelect from './ModelSelect';
import ParamSlider from './ParamSlider';
import ImageModal from './ImageModal';
import GalleryPicker from './GalleryPicker';
import QueueTray from './QueueTray';
import type { CheckpointConfig, GenerationParams, GenerationRecord, LoraConfig, VideoRemixData, ProjectContext, ProjectDetail, ProjectClip, ProjectStitchedExport, WanLoraEntry, WanLoraSpec } from '@/types';
import { SAMPLERS, SCHEDULERS, RESOLUTIONS } from '@/types';
import type { Tab } from '@/app/page';
import { imgSrc } from '@/lib/imageSrc';
import ReferencePanel from './ReferencePanel';
import ProjectPicker from './ProjectPicker';
import NewProjectModal from './NewProjectModal';
import { useQueue, type ActiveJob } from '@/contexts/QueueContext';
import type { ActiveJobInfo } from '@/lib/comfyws';
import { useModelLists } from '@/lib/useModelLists';
import VideoLoraStack from './VideoLoraStack';

interface CheckpointDefaults {
  positivePrompt: string;
  negativePrompt: string;
}

const DEFAULTS: GenerationParams = {
  checkpoint: '',
  loras: [],
  positivePrompt: '',
  negativePrompt: '',
  width: 1024,
  height: 1024,
  steps: 35,
  cfg: 7,
  seed: -1,
  sampler: 'euler',
  scheduler: 'karras',
  batchSize: 1,
  highResFix: false,
};

// ── Video mode types ──────────────────────────────────────────────────────────

interface VideoParams {
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
}

const VIDEO_DEFAULTS: VideoParams = {
  width: 1280,
  height: 704,
  frames: 57,
  steps: 20,
  cfg: 3.5,
};

// Valid Wan 2.2 frame counts: (frames - 1) % 8 === 0, range 17–121
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

const VIDEO_PRESETS = [
  { label: '1280×704', w: 1280, h: 704 },
  { label: '768×768', w: 768, h: 768 },
  { label: '704×1280', w: 704, h: 1280 },
] as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  tab: Tab;
  onGenerated: () => void;
  remixParams: GenerationParams | null;
  onRemixConsumed: () => void;
  videoRemixParams: VideoRemixData | null;
  onVideoRemixConsumed: () => void;
  onRemix: (record: GenerationRecord) => void;
  modelConfigVersion: number;
  onNavigateToGallery: () => void;
  /** Set by Projects tab when "Generate new clip" is clicked. Triggers mode switch + pre-fill. */
  projectContextTrigger: ProjectContext | null;
  onProjectContextTriggerConsumed: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSessionMode(): 'image' | 'video' {
  try {
    const v = sessionStorage.getItem('studio-mode');
    return v === 'video' ? 'video' : 'image';
  } catch {
    return 'image';
  }
}

function readSessionProjectContext(): ProjectContext | null {
  try {
    const s = sessionStorage.getItem('studio-project-context');
    return s ? JSON.parse(s) as ProjectContext : null;
  } catch {
    return null;
  }
}

function saveSessionProjectContext(ctx: ProjectContext | null) {
  try {
    if (ctx) {
      sessionStorage.setItem('studio-project-context', JSON.stringify(ctx));
    } else {
      sessionStorage.removeItem('studio-project-context');
    }
  } catch { /* ignore */ }
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

// ── Project frame picker ──────────────────────────────────────────────────────

/** A project clip or stitched export as presented in the starting-frame picker. */
interface PickerItem {
  id: string;
  filePath: string;
  mediaType: string;
  isStitched: boolean;
  position: number | null;
  prompt: string;
}

interface ProjectFramePickerProps {
  open: boolean;
  items: PickerItem[];
  loading: boolean;
  initialSelectedId: string | null;
  frameCache: React.MutableRefObject<Map<string, string>>;
  onConfirm: (id: string | null) => void;
  onClose: () => void;
}

function ProjectFramePickerModal({
  open,
  items,
  loading,
  initialSelectedId,
  frameCache,
  onConfirm,
  onClose,
}: ProjectFramePickerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set());
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelectedId(initialSelectedId);
    setFailedIds(new Set());
  }, [open, initialSelectedId]);

  // Extract last frames for video items whenever the picker opens or items change
  useEffect(() => {
    if (!open || items.length === 0) return;

    const videoItems = items.filter(
      (i) => i.mediaType === 'video' && !frameCache.current.has(i.id),
    );
    if (videoItems.length === 0) return;

    setExtractingIds((prev) => new Set([...prev, ...videoItems.map((i) => i.id)]));

    let cancelled = false;

    void Promise.all(
      videoItems.map(async (item) => {
        try {
          const res = await fetch('/api/extract-last-frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generationId: item.id }),
          });
          const data = await res.json() as { frameB64?: string; error?: string };
          if (cancelled) return;
          if (data.frameB64) {
            frameCache.current.set(item.id, data.frameB64);
          } else {
            setFailedIds((prev) => new Set([...prev, item.id]));
          }
        } catch {
          if (!cancelled) setFailedIds((prev) => new Set([...prev, item.id]));
        } finally {
          if (!cancelled) {
            setExtractingIds((prev) => {
              const s = new Set(prev);
              s.delete(item.id);
              return s;
            });
          }
        }
      }),
    );

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">Choose starting frame</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <svg className="w-6 h-6 text-violet-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-8">No clips in this project yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {items.map((item) => {
                const isSelected = item.id === selectedId;
                const isExtracting = extractingIds.has(item.id);
                const isFailed = failedIds.has(item.id);
                const cachedFrame = frameCache.current.get(item.id);

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => !isFailed && setSelectedId(item.id)}
                    disabled={isFailed}
                    className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all
                      ${isSelected
                        ? 'border-violet-500'
                        : isFailed
                          ? 'border-zinc-800 opacity-50 cursor-not-allowed'
                          : 'border-zinc-700 hover:border-zinc-500'}`}
                  >
                    {item.mediaType === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgSrc(item.filePath)} alt="" className="w-full h-full object-cover bg-zinc-800" />
                    ) : cachedFrame ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={cachedFrame} alt="" className="w-full h-full object-cover bg-zinc-800" />
                    ) : isExtracting ? (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <svg className="w-5 h-5 text-violet-400 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                        </svg>
                      </div>
                    ) : isFailed ? (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-xs text-zinc-500 px-1 text-center">Preview failed</span>
                      </div>
                    ) : (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <video
                        src={imgSrc(item.filePath)}
                        preload="metadata"
                        muted
                        playsInline
                        className="w-full h-full object-cover bg-zinc-800"
                      />
                    )}
                    {/* Position / Stitched badge */}
                    <div className={`absolute top-1 left-1 px-1 py-0.5 rounded text-xs font-bold select-none pointer-events-none
                      ${item.isStitched ? 'bg-emerald-900/80 text-emerald-300' : 'bg-black/70 text-white'}`}>
                      {item.isStitched ? 'Stitched' : (item.position ?? '')}
                    </div>
                    {isSelected && (
                      <div className="absolute inset-0 ring-2 ring-violet-500 ring-inset rounded-lg pointer-events-none" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 border-t border-zinc-800 flex gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-12 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selectedId)}
            disabled={!selectedId}
            className="flex-1 min-h-12 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Studio({
  tab,
  onGenerated,
  remixParams,
  onRemixConsumed,
  videoRemixParams,
  onVideoRemixConsumed,
  onRemix,
  modelConfigVersion,
  onNavigateToGallery,
  projectContextTrigger,
  onProjectContextTriggerConsumed,
}: Props) {
  const {
    addJob,
    updateProgress,
    setCompleting,
    completeJob,
    failJob,
    requestPermissionIfNeeded,
  } = useQueue();

  const { data: modelLists } = useModelLists(modelConfigVersion);

  // mode — starts 'image'; actual session value applied on mount to avoid SSR mismatch
  const [mode, setMode] = useState<'image' | 'video'>('image');

  // image params
  const [p, setP] = useState<GenerationParams>(DEFAULTS);

  // video params (separate state; only active in video mode)
  const [videoP, setVideoP] = useState<VideoParams>(VIDEO_DEFAULTS);
  // Lightning mode — separate from videoP so steps/cfg are preserved when toggled off
  const [lightning, setLightning] = useState(() => {
    try { return sessionStorage.getItem('studio-video-lightning') === 'true'; } catch { return false; }
  });
  // Video LoRA stack — Wan 2.2 LoRAs only; persisted in sessionStorage
  const [videoLoras, setVideoLoras] = useState<WanLoraEntry[]>(() => {
    try {
      const s = sessionStorage.getItem('studio-video-loras');
      return s ? JSON.parse(s) as WanLoraEntry[] : [];
    } catch { return []; }
  });
  const [useStartingFrame, setUseStartingFrame] = useState(false);
  const [startingFrameRecord, setStartingFrameRecord] = useState<GenerationRecord | null>(null);
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);
  const [lastVideoResults, setLastVideoResults] = useState<GenerationRecord[]>([]);
  const [videoBatchSize, setVideoBatchSize] = useState(1);

  // Project context — set when navigating from Projects tab; persisted in sessionStorage
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  // Scene ID from a storyboard scene trigger — flows to the generate-video request body
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  // Project frame picker (replaces the "use last frame" checkbox)
  const [selectedStartingClipId, setSelectedStartingClipId] = useState<string | null>(null);
  const [framePickerOpen, setFramePickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([]);
  const [pickerFetching, setPickerFetching] = useState(false);
  // Persists last-frame extractions across picker open/close cycles
  const frameCache = useRef<Map<string, string>>(new Map());
  // Submit-time loading indicator (extracting frame before generation)
  const [extractingLastFrame, setExtractingLastFrame] = useState(false);
  // Project picker (clickable badge)
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);

  // Inline result display for the most recently completed image/video
  const [lastImageRecords, setLastImageRecords] = useState<GenerationRecord[]>([]);
  const [lastResolvedSeed, setLastResolvedSeed] = useState(-1);

  // Submit-level errors (network failures before job starts)
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalStartIdx, setModalStartIdx] = useState(0);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoModalIdx, setVideoModalIdx] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [checkpointDefaults, setCheckpointDefaults] = useState<CheckpointDefaults | null>(null);
  const [checkpointConfig, setCheckpointConfig] = useState<CheckpointConfig | null>(null);
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [mask, setMask] = useState<string | null>(null);
  const [baseImageDenoise, setBaseImageDenoise] = useState(0.65);
  const [faceReferences, setFaceReferences] = useState<string[]>([]);
  const [faceStrength, setFaceStrength] = useState(0.85);
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false); // 800ms double-tap guard
  const polishErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply session mode on mount + recover in-flight jobs from server
  useEffect(() => {
    setMode(readSessionMode());
    setProjectContext(readSessionProjectContext());

    // On mount, poll for any in-flight jobs on the server (post-refresh recovery)
    fetch('/api/jobs/active')
      .then((r) => r.json())
      .then(({ jobs: serverJobs }: { jobs: ActiveJobInfo[] }) => {
        for (const sj of serverJobs) {
          const job: ActiveJob = {
            promptId: sj.promptId,
            generationId: sj.generationId,
            mediaType: sj.mediaType,
            promptSummary: sj.promptSummary,
            startedAt: sj.startedAt || Date.now(),
            runningSince: sj.runningSince ?? null,
            progress: sj.progress,
            // Map server status to client status
            status: sj.status === 'done' ? 'done'
              : sj.status === 'error' ? 'error'
              : sj.status === 'queued' ? 'queued'
              : 'running',
          };
          if (sj.status === 'error') job.errorMessage = sj.errorMessage;
          addJob(job);
        }
      })
      .catch(() => { /* non-critical — queue will be empty on fresh load */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear project context when the active project is deleted from another view
  useEffect(() => {
    function handleProjectDeleted(e: Event) {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      setProjectContext((prev) => {
        if (prev?.projectId === id) {
          saveSessionProjectContext(null);
          return null;
        }
        return prev;
      });
    }
    window.addEventListener('project-deleted', handleProjectDeleted);
    return () => window.removeEventListener('project-deleted', handleProjectDeleted);
  }, []);

  // Clear stale results when navigating away from Studio
  useEffect(() => {
    if (tab !== 'studio') {
      setDrawerOpen(false);
      setLastImageRecords([]);
      setLastVideoResults([]);
      setSubmitError(null);
    }
  }, [tab]);

  // Lift the Generate bar above the iOS soft keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function handleViewport() {
      const offset = window.innerHeight - vv!.height - vv!.offsetTop;
      setKeyboardOffset(Math.max(0, offset));
    }
    vv.addEventListener('resize', handleViewport);
    vv.addEventListener('scroll', handleViewport);
    return () => {
      vv.removeEventListener('resize', handleViewport);
      vv.removeEventListener('scroll', handleViewport);
    };
  }, []);

  // Apply image remix params from Gallery (remix is always project-less)
  useEffect(() => {
    if (!remixParams) return;
    setP({ ...remixParams, batchSize: 4 });
    // Remix clears project context and scene state
    setProjectContext(null);
    saveSessionProjectContext(null);
    setSelectedStartingClipId(null);
    setPickerItems([]);
    setActiveSceneId(null);
    setMode('image');
    try { sessionStorage.setItem('studio-mode', 'image'); } catch { /* ignore */ }
    onRemixConsumed();
    if (remixParams.checkpoint) {
      fetch(`/api/checkpoint-config?name=${encodeURIComponent(remixParams.checkpoint)}`)
        .then((r) => (r.ok ? r.json() as Promise<CheckpointConfig> : null))
        .then((config) => {
          setCheckpointConfig(config ?? null);
          setCheckpointDefaults(config
            ? { positivePrompt: config.defaultPositivePrompt, negativePrompt: config.defaultNegativePrompt }
            : null,
          );
        })
        .catch(() => {});
    } else {
      setCheckpointDefaults(null);
    }
  }, [remixParams, onRemixConsumed]);

  // Apply video remix params from Gallery (remix is always project-less)
  useEffect(() => {
    if (!videoRemixParams) return;
    setVideoP({
      width: videoRemixParams.width,
      height: videoRemixParams.height,
      frames: videoRemixParams.frames,
      steps: videoRemixParams.steps,
      cfg: videoRemixParams.cfg,
    });
    setVideoBatchSize(4);
    setP((prev) => ({ ...prev, positivePrompt: videoRemixParams.positivePrompt, seed: videoRemixParams.seed ?? -1 }));
    setLightningAndPersist(videoRemixParams.lightning ?? false);
    const loraEntries: WanLoraEntry[] = videoRemixParams.videoLoras
      ? videoRemixParams.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }))
      : [];
    setVideoLorasAndPersist(loraEntries);
    setUseStartingFrame(false);
    setStartingFrameRecord(null);
    setSelectedStartingClipId(null);
    setPickerItems([]);
    setLastVideoResults([]);
    // Remix clears project context and scene state — remix is a fresh generation, not a project continuation
    setProjectContext(null);
    saveSessionProjectContext(null);
    setActiveSceneId(null);
    setMode('video');
    try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }
    onVideoRemixConsumed();
  }, [videoRemixParams, onVideoRemixConsumed]);

  // Apply project context trigger from Projects tab
  useEffect(() => {
    if (!projectContextTrigger) return;

    setProjectContext(projectContextTrigger);
    saveSessionProjectContext(projectContextTrigger);

    // Scene context overrides: always open video mode and apply scene-specific values
    if (projectContextTrigger.sceneContext) {
      const sc = projectContextTrigger.sceneContext;

      setMode('video');
      setLastVideoResults([]);
      setSubmitError(null);
      try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }

      // Apply project defaults first (same as regular video mode trigger)
      setVideoP({
        frames: clampToValidFrameCount(sc.durationSeconds * 16),
        steps: projectContextTrigger.defaults.steps ?? VIDEO_DEFAULTS.steps,
        cfg: projectContextTrigger.defaults.cfg ?? VIDEO_DEFAULTS.cfg,
        width: projectContextTrigger.defaults.width ?? VIDEO_DEFAULTS.width,
        height: projectContextTrigger.defaults.height ?? VIDEO_DEFAULTS.height,
      });

      if (projectContextTrigger.defaults.lightning !== null && projectContextTrigger.defaults.lightning !== undefined) {
        setLightningAndPersist(projectContextTrigger.defaults.lightning);
      }

      if (projectContextTrigger.defaults.videoLoras) {
        const entries = projectContextTrigger.defaults.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
        setVideoLorasAndPersist(entries);
      }

      // Override prompt with scene's prompt
      setP((prev) => ({ ...prev, positivePrompt: sc.prompt }));

      // Stash sceneId for the generate-video request
      setActiveSceneId(sc.sceneId);

      // Suggest starting frame from previous scene's canonical clip
      setUseStartingFrame(false);
      setStartingFrameRecord(null);
      if (sc.suggestedStartingClipId) {
        setSelectedStartingClipId(sc.suggestedStartingClipId);
      } else {
        setSelectedStartingClipId(null);
      }
      setPickerItems([]);

      onProjectContextTriggerConsumed();
      return;
    }

    // Regular (non-scene) project context trigger
    setActiveSceneId(null);

    if (projectContextTrigger.mode === 'video') {
      setMode('video');
      setLastVideoResults([]);
      setSubmitError(null);
      try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }

      setVideoP({
        frames: projectContextTrigger.defaults.frames ?? VIDEO_DEFAULTS.frames,
        steps: projectContextTrigger.defaults.steps ?? VIDEO_DEFAULTS.steps,
        cfg: projectContextTrigger.defaults.cfg ?? VIDEO_DEFAULTS.cfg,
        width: projectContextTrigger.defaults.width ?? VIDEO_DEFAULTS.width,
        height: projectContextTrigger.defaults.height ?? VIDEO_DEFAULTS.height,
      });

      if (projectContextTrigger.defaults.lightning !== null && projectContextTrigger.defaults.lightning !== undefined) {
        setLightningAndPersist(projectContextTrigger.defaults.lightning);
      }

      if (projectContextTrigger.defaults.videoLoras) {
        const entries = projectContextTrigger.defaults.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
        setVideoLorasAndPersist(entries);
      }
    } else {
      setMode('image');
      setLastImageRecords([]);
      setSubmitError(null);
      try { sessionStorage.setItem('studio-mode', 'image'); } catch { /* ignore */ }

      if (projectContextTrigger.defaults.width !== null || projectContextTrigger.defaults.height !== null) {
        setP((prev) => ({
          ...prev,
          ...(projectContextTrigger.defaults.width !== null ? { width: projectContextTrigger.defaults.width! } : {}),
          ...(projectContextTrigger.defaults.height !== null ? { height: projectContextTrigger.defaults.height! } : {}),
        }));
      }
    }

    // Carry forward latest clip's prompt regardless of mode
    if (projectContextTrigger.latestClipPrompt) {
      setP((prev) => ({ ...prev, positivePrompt: projectContextTrigger.latestClipPrompt! }));
    }

    // Reset starting frame state
    setUseStartingFrame(false);
    setStartingFrameRecord(null);
    setSelectedStartingClipId(null);
    setPickerItems([]);

    onProjectContextTriggerConsumed();
  }, [projectContextTrigger, onProjectContextTriggerConsumed]);

  // ── Param helpers ─────────────────────────────────────────────────────────

  function update<K extends keyof GenerationParams>(key: K, val: GenerationParams[K]) {
    setP((prev) => ({ ...prev, [key]: val }));
  }

  function updateVideo<K extends keyof VideoParams>(key: K, val: VideoParams[K]) {
    setVideoP((prev) => ({ ...prev, [key]: val }));
  }

  function setLightningAndPersist(val: boolean) {
    setLightning(val);
    try { sessionStorage.setItem('studio-video-lightning', String(val)); } catch { /* ignore */ }
  }

  function setVideoLorasAndPersist(loras: WanLoraEntry[]) {
    setVideoLoras(loras);
    try { sessionStorage.setItem('studio-video-loras', JSON.stringify(loras)); } catch { /* ignore */ }
  }

  function clearProjectContext() {
    setProjectContext(null);
    saveSessionProjectContext(null);
    setSelectedStartingClipId(null);
    setPickerItems([]);
  }

  async function openFramePicker() {
    if (!projectContext) return;
    setFramePickerOpen(true);
    if (pickerItems.length > 0) return; // already loaded
    setPickerFetching(true);
    try {
      const res = await fetch(`/api/projects/${projectContext.projectId}`);
      if (!res.ok) return;
      const data = await res.json() as {
        clips: ProjectClip[];
        stitchedExports: ProjectStitchedExport[];
      };
      setPickerItems([
        ...data.clips.map((c) => ({
          id: c.id,
          filePath: c.filePath,
          mediaType: c.mediaType,
          isStitched: false,
          position: c.position,
          prompt: c.prompt,
        })),
        ...data.stitchedExports.map((e) => ({
          id: e.id,
          filePath: e.filePath,
          mediaType: 'video' as const,
          isStitched: true,
          position: null,
          prompt: e.promptPos,
        })),
      ]);
    } catch {
      // non-critical — picker will show empty state
    } finally {
      setPickerFetching(false);
    }
  }

  async function handleProjectSwitch(projectId: string | null, projectName: string | null) {
    setShowProjectPicker(false);
    if (!projectId) {
      // "None" — clear context without touching form values
      clearProjectContext();
      return;
    }
    // Same project — no-op
    if (projectId === projectContext?.projectId) return;

    setSwitchingProject(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) return;
      const { project, clips } = await res.json() as { project: ProjectDetail; clips: ProjectClip[] };

      // Latest clip = last entry in position-ascending order
      const latestClip = clips.length > 0 ? clips[clips.length - 1] : null;

      const newCtx: ProjectContext = {
        projectId: project.id,
        projectName: project.name,
        mode,
        latestClipId: latestClip?.id ?? null,
        latestClipPrompt: latestClip?.prompt ?? null,
        latestClipMediaType: latestClip?.mediaType ?? null,
        latestClipFilePath: latestClip?.filePath ?? null,
        defaults: {
          frames: project.defaultFrames ?? null,
          steps: project.defaultSteps ?? null,
          cfg: project.defaultCfg ?? null,
          width: project.defaultWidth ?? null,
          height: project.defaultHeight ?? null,
          lightning: project.defaultLightning ?? null,
          videoLoras: project.defaultVideoLoras ?? null,
        },
      };

      setProjectContext(newCtx);
      saveSessionProjectContext(newCtx);

      // Hard reset video params to new project's defaults
      setVideoP({
        frames: newCtx.defaults.frames ?? VIDEO_DEFAULTS.frames,
        steps: newCtx.defaults.steps ?? VIDEO_DEFAULTS.steps,
        cfg: newCtx.defaults.cfg ?? VIDEO_DEFAULTS.cfg,
        width: newCtx.defaults.width ?? VIDEO_DEFAULTS.width,
        height: newCtx.defaults.height ?? VIDEO_DEFAULTS.height,
      });

      // Apply lightning default if project has one
      if (newCtx.defaults.lightning !== null) {
        setLightningAndPersist(newCtx.defaults.lightning);
      }

      // Pre-fill video LoRA stack from project defaults if provided
      if (newCtx.defaults.videoLoras) {
        const entries = newCtx.defaults.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
        setVideoLorasAndPersist(entries);
      }

      // Pre-fill prompt from latest clip; clear if no clips
      setP((prev) => ({ ...prev, positivePrompt: newCtx.latestClipPrompt ?? '' }));

      // Reset starting-frame state
      setUseStartingFrame(false);
      setStartingFrameRecord(null);
      setSelectedStartingClipId(null);
      setPickerItems([]);

      // Switch to video mode
      setMode('video');
      setLastVideoResults([]);
      setSubmitError(null);
      try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }
    } catch {
      // non-critical — don't switch context on fetch failure
    } finally {
      setSwitchingProject(false);
    }
  }

  function handleNewProjectCreated(project: ProjectDetail) {
    setShowNewProjectModal(false);
    const newCtx: ProjectContext = {
      projectId: project.id,
      projectName: project.name,
      mode,
      latestClipId: null,
      latestClipPrompt: null,
      latestClipMediaType: null,
      latestClipFilePath: null,
      defaults: {
        frames: project.defaultFrames ?? null,
        steps: project.defaultSteps ?? null,
        cfg: project.defaultCfg ?? null,
        width: project.defaultWidth ?? null,
        height: project.defaultHeight ?? null,
        lightning: project.defaultLightning ?? null,
        videoLoras: project.defaultVideoLoras ?? null,
      },
    };
    setProjectContext(newCtx);
    saveSessionProjectContext(newCtx);

    setVideoP({
      frames: newCtx.defaults.frames ?? VIDEO_DEFAULTS.frames,
      steps: newCtx.defaults.steps ?? VIDEO_DEFAULTS.steps,
      cfg: newCtx.defaults.cfg ?? VIDEO_DEFAULTS.cfg,
      width: newCtx.defaults.width ?? VIDEO_DEFAULTS.width,
      height: newCtx.defaults.height ?? VIDEO_DEFAULTS.height,
    });

    if (newCtx.defaults.lightning !== null) {
      setLightningAndPersist(newCtx.defaults.lightning);
    }

    // Pre-fill video LoRA stack from project defaults if provided
    if (newCtx.defaults.videoLoras) {
      const entries = newCtx.defaults.videoLoras.map((s) => ({ loraName: s.loraName, weight: s.weight }));
      setVideoLorasAndPersist(entries);
    }

    // Clear prompt — new project has no clips
    setP((prev) => ({ ...prev, positivePrompt: '' }));

    setUseStartingFrame(false);
    setStartingFrameRecord(null);
    setSelectedStartingClipId(null);
    setPickerItems([]);

    setMode('video');
    setLastVideoResults([]);
    setSubmitError(null);
    try { sessionStorage.setItem('studio-mode', 'video'); } catch { /* ignore */ }
  }

  function switchMode(newMode: 'image' | 'video') {
    if (newMode === mode) return;
    setLastImageRecords([]);
    setLastVideoResults([]);
    setSubmitError(null);
    setActiveSceneId(null);
    if (newMode === 'video') {
      // Don't reset videoP if a project context pre-filled it
      if (!projectContext) setVideoP(VIDEO_DEFAULTS);
      setUseStartingFrame(false);
      setStartingFrameRecord(null);
      setSelectedStartingClipId(null);
    }
    setMode(newMode);
    try { sessionStorage.setItem('studio-mode', newMode); } catch { /* ignore */ }
  }

  async function handleCheckpointChange(newCheckpoint: string) {
    update('checkpoint', newCheckpoint);
    if (!newCheckpoint) { setCheckpointDefaults(null); return; }
    try {
      const res = await fetch(`/api/checkpoint-config?name=${encodeURIComponent(newCheckpoint)}`);
      if (!res.ok) { setCheckpointConfig(null); setCheckpointDefaults(null); return; }
      const config = await res.json() as CheckpointConfig;
      setCheckpointConfig(config);
      setCheckpointDefaults({
        positivePrompt: config.defaultPositivePrompt,
        negativePrompt: config.defaultNegativePrompt,
      });
      // Soft-fill: apply all non-null defaults from this checkpoint config.
      // Width/height are applied only when both are non-null. Other generation params
      // (steps, cfg, sampler, scheduler, hrf) are only applied when non-null.
      setP((s) => {
        const updates: Partial<GenerationParams> = {};
        if (config.defaultWidth != null && config.defaultHeight != null) {
          updates.width = config.defaultWidth;
          updates.height = config.defaultHeight;
        }
        if (config.defaultSteps != null) updates.steps = config.defaultSteps;
        if (config.defaultCfg != null) updates.cfg = config.defaultCfg;
        if (config.defaultSampler != null) updates.sampler = config.defaultSampler;
        if (config.defaultScheduler != null) updates.scheduler = config.defaultScheduler;
        if (config.defaultHrf != null) updates.highResFix = config.defaultHrf;
        return { ...s, ...updates };
      });
    } catch {
      // non-critical
    }
  }

  // Called by ModelSelect's auto-selection on mount (not an explicit user gesture).
  // Applies width/height and hints only — does NOT apply new generation defaults,
  // so the user's last-session values are preserved after a page refresh.
  async function handleInitialCheckpoint(newCheckpoint: string) {
    update('checkpoint', newCheckpoint);
    if (!newCheckpoint) { setCheckpointDefaults(null); return; }
    try {
      const res = await fetch(`/api/checkpoint-config?name=${encodeURIComponent(newCheckpoint)}`);
      if (!res.ok) { setCheckpointConfig(null); setCheckpointDefaults(null); return; }
      const config = await res.json() as CheckpointConfig;
      setCheckpointConfig(config);
      setCheckpointDefaults({
        positivePrompt: config.defaultPositivePrompt,
        negativePrompt: config.defaultNegativePrompt,
      });
      if (config.defaultWidth != null && config.defaultHeight != null) {
        setP((s) => ({ ...s, width: config.defaultWidth!, height: config.defaultHeight! }));
      }
    } catch {
      // non-critical
    }
  }

  // ── Image generation ──────────────────────────────────────────────────────

  async function handleGenerate() {
    if (submitting) return;
    setSubmitting(true);
    setTimeout(() => setSubmitting(false), 800);
    setDrawerOpen(false);
    setSubmitError(null);

    const submitTime = Date.now();
    const promptSummary = p.positivePrompt.slice(0, 60).trim() || 'Image generation';
    const batchSize = p.batchSize ?? 1;
    const baseSeed = p.seed;

    // Clear previous results before starting new batch
    setLastImageRecords([]);
    setLastResolvedSeed(-1);

    const basePayload: GenerationParams = {
      ...p,
      batchSize: 1, // each take is its own single-image workflow
      // Enrich loras with friendlyName so workflow.ts can use it for _meta.title
      loras: p.loras.map((l) => ({
        ...l,
        friendlyName: modelLists.loraNames[l.name] ?? '(unknown LoRA)',
      })),
      baseImage: baseImage ?? undefined,
      mask: mask ?? undefined,
      denoise: baseImage ? baseImageDenoise : undefined,
      referenceImages: faceReferences.length > 0
        ? { images: faceReferences, strength: faceStrength }
        : undefined,
      projectId: projectContext?.projectId ?? undefined,
    };

    // Request notification permission on first submit (once per batch)
    requestPermissionIfNeeded();

    for (let i = 0; i < batchSize; i++) {
      // seed === -1: route randomizes per take; explicit seed: sequential seed + i for reproducibility
      const takeSeed = baseSeed === -1 ? -1 : baseSeed + i;
      const generateParams: GenerationParams = { ...basePayload, seed: takeSeed };

      let res: Response;
      try {
        res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generateParams),
        });
      } catch (err) {
        setSubmitError(String(err));
        return;
      }

      if (!res.ok) {
        try {
          const errBody = await res.json() as { error: string };
          setSubmitError(errBody.error);
        } catch {
          setSubmitError(`HTTP ${res.status}`);
        }
        return;
      }

      if (!res.body) {
        setSubmitError('No response stream');
        return;
      }

      // Process this take's SSE stream in the background — don't block the submission loop
      const reader = res.body.getReader();
      const takeIndex = i;

      void (async () => {
        const dec = new TextDecoder();
        let lineBuf = '';
        let currentEvt = '';
        let streamDone = false;
        let jobPromptId = '';
        let jobAdded = false;

        try {
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuf += dec.decode(value, { stream: true });
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvt = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (currentEvt === 'init') {
                  const initData = JSON.parse(dataStr) as { promptId: string; resolvedSeed: number };
                  jobPromptId = initData.promptId;
                  // Display the first take's seed; subsequent takes visible in gallery
                  if (takeIndex === 0) setLastResolvedSeed(initData.resolvedSeed);
                  if (!jobAdded) {
                    jobAdded = true;
                    addJob({
                      promptId: jobPromptId,
                      generationId: '',
                      mediaType: 'image',
                      promptSummary,
                      startedAt: submitTime,
                      runningSince: null,
                      progress: null,
                      status: 'queued',
                    });
                  }
                } else if (currentEvt === 'progress') {
                  const pd = JSON.parse(dataStr) as { value: number; max: number };
                  if (jobPromptId) updateProgress(jobPromptId, { current: pd.value, total: pd.max });
                } else if (currentEvt === 'completing') {
                  if (jobPromptId) setCompleting(jobPromptId);
                } else if (currentEvt === 'complete') {
                  const d = JSON.parse(dataStr) as { records: GenerationRecord[] };
                  // Accumulate results as each take completes — order depends on ComfyUI queue
                  setLastImageRecords((prev) => [...prev, ...d.records]);
                  if (jobPromptId) completeJob(jobPromptId, d.records[0]?.id ?? '');
                  onGenerated();
                  reader.cancel();
                  streamDone = true;
                  break;
                } else if (currentEvt === 'error') {
                  const er = JSON.parse(dataStr) as { message: string };
                  if (jobPromptId) {
                    failJob(jobPromptId, er.message);
                  } else {
                    setSubmitError(er.message);
                  }
                  reader.cancel();
                  streamDone = true;
                  break;
                }
                currentEvt = '';
              }
            }
          }
        } catch {
          if (jobPromptId) failJob(jobPromptId, 'SSE connection lost');
        }
      })();
    }
  }

  // ── Video generation ──────────────────────────────────────────────────────

  async function handleGenerateVideo() {
    if (submitting) return;
    setSubmitting(true);
    setTimeout(() => setSubmitting(false), 800);
    setSubmitError(null);
    setLastVideoResults([]);

    const submitTime = Date.now();
    const promptSummary = p.positivePrompt.slice(0, 60).trim() || 'Video generation';
    const batchSize = videoBatchSize;
    const baseSeed = p.seed;

    // ── Resolve starting frame once before the loop ───────────────────────
    let startImageB64: string | undefined;

    if (selectedStartingClipId) {
      // Project frame picker path
      const item = pickerItems.find((pi) => pi.id === selectedStartingClipId);
      if (item) {
        setExtractingLastFrame(true);
        try {
          if (item.mediaType === 'image') {
            startImageB64 = await encodeImageToBase64(imgSrc(item.filePath));
          } else {
            // Use cached last-frame if available, otherwise extract now
            const cached = frameCache.current.get(item.id);
            if (cached) {
              startImageB64 = cached.replace(/^data:image\/[^;]+;base64,/, '');
            } else {
              const lfRes = await fetch('/api/extract-last-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ generationId: item.id }),
              });
              const lfData = await lfRes.json() as { frameB64?: string; error?: string };
              if (!lfRes.ok || !lfData.frameB64) {
                throw new Error(lfData.error ?? 'Failed to extract last frame');
              }
              startImageB64 = lfData.frameB64.replace(/^data:image\/[^;]+;base64,/, '');
            }
          }
        } catch (err) {
          setSubmitError(`Failed to prepare starting frame: ${String(err)}`);
          return;
        } finally {
          setExtractingLastFrame(false);
        }
      }
    } else if (useStartingFrame && startingFrameRecord) {
      // Gallery picker path (non-project I2V)
      try {
        startImageB64 = await encodeImageToBase64(imgSrc(startingFrameRecord.filePath));
      } catch (err) {
        setSubmitError(`Failed to load starting frame: ${String(err)}`);
        return;
      }
    }

    const videoMode: 't2v' | 'i2v' = startImageB64 ? 'i2v' : 't2v';

    // Build full WanLoraSpec[] once — same across all takes
    const wanLoras: WanLoraSpec[] = videoLoras.map((e) => ({
      loraName: e.loraName,
      friendlyName: modelLists.loraNames[e.loraName] ?? '(unknown LoRA)',
      weight: e.weight,
      appliesToHigh: modelLists.loraAppliesToHigh[e.loraName] ?? true,
      appliesToLow: modelLists.loraAppliesToLow[e.loraName] ?? true,
    }));

    // Request notification permission once before the batch
    requestPermissionIfNeeded();

    for (let i = 0; i < batchSize; i++) {
      // seed === -1: route randomizes independently per take; explicit: sequential seed+i
      const takeSeed = baseSeed === -1 ? -1 : baseSeed + i;

      let res: Response;
      try {
        res = await fetch('/api/generate-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: videoMode,
            prompt: p.positivePrompt.trim(),
            width: videoP.width,
            height: videoP.height,
            frames: videoP.frames,
            steps: videoP.steps,
            cfg: videoP.cfg,
            seed: takeSeed,
            lightning,
            loras: wanLoras.length > 0 ? wanLoras : undefined,
            ...(startImageB64 ? { startImageB64 } : {}),
            ...(projectContext ? { projectId: projectContext.projectId } : {}),
            ...(activeSceneId ? { sceneId: activeSceneId } : {}),
          }),
        });
      } catch (err) {
        setSubmitError(String(err));
        return;
      }

      if (!res.ok) {
        try {
          const errBody = await res.json() as { error: string };
          setSubmitError(errBody.error);
        } catch {
          setSubmitError(`HTTP ${res.status}`);
        }
        return;
      }

      if (!res.body) {
        setSubmitError('No response stream');
        return;
      }

      // Process this take's SSE stream in the background — don't block the submission loop
      const reader = res.body.getReader();

      void (async () => {
        const dec = new TextDecoder();
        let lineBuf = '';
        let currentEvt = '';
        let streamDone = false;
        let jobPromptId = '';
        let jobAdded = false;

        try {
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuf += dec.decode(value, { stream: true });
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvt = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (currentEvt === 'init') {
                  const initData = JSON.parse(dataStr) as { promptId: string; generationId: string };
                  jobPromptId = initData.promptId;
                  if (!jobAdded) {
                    jobAdded = true;
                    addJob({
                      promptId: jobPromptId,
                      generationId: initData.generationId,
                      mediaType: 'video',
                      promptSummary,
                      startedAt: submitTime,
                      runningSince: null,
                      progress: null,
                      status: 'queued',
                    });
                  }
                } else if (currentEvt === 'progress') {
                  const pd = JSON.parse(dataStr) as { value: number; max: number };
                  if (jobPromptId) updateProgress(jobPromptId, { current: pd.value, total: pd.max });
                } else if (currentEvt === 'completing') {
                  if (jobPromptId) setCompleting(jobPromptId);
                } else if (currentEvt === 'complete') {
                  const d = JSON.parse(dataStr) as { records: GenerationRecord[] };
                  setLastVideoResults((prev) => [...prev, ...d.records]);
                  if (jobPromptId) completeJob(jobPromptId, d.records[0]?.id ?? '');
                  onGenerated();
                  // Clear activeSceneId after first take completes — subsequent takes from
                  // the same submit don't carry the scene ID
                  setActiveSceneId(null);
                  reader.cancel();
                  streamDone = true;
                  break;
                } else if (currentEvt === 'error') {
                  const er = JSON.parse(dataStr) as { message: string };
                  if (jobPromptId) {
                    failJob(jobPromptId, er.message);
                  } else {
                    setSubmitError(er.message);
                  }
                  reader.cancel();
                  streamDone = true;
                  break;
                }
                currentEvt = '';
              }
            }
          }
        } catch {
          if (jobPromptId) failJob(jobPromptId, 'SSE connection lost');
        }
      })();
    }
  }

  // ── Misc handlers ─────────────────────────────────────────────────────────

  async function handleStudioDelete(id: string): Promise<void> {
    const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    setLastImageRecords((prev) => prev.filter((r) => r.id !== id));
    onGenerated();
  }

  async function handlePolish() {
    if (polishing) return;
    setPolishing(true);
    setPolishError(null);
    if (polishErrorTimer.current) clearTimeout(polishErrorTimer.current);
    try {
      let triggerWords: string[] = [];
      if (p.loras.length > 0) {
        try {
          const loraConfigs = await fetch('/api/lora-config').then((r) => r.json() as Promise<LoraConfig[]>);
          const activeNames = new Set(p.loras.map((l) => l.name));
          triggerWords = loraConfigs
            .filter((c) => activeNames.has(c.loraName) && c.triggerWords?.trim())
            .flatMap((c) => c.triggerWords.split(',').map((w) => w.trim()).filter(Boolean));
        } catch {
          // non-critical
        }
      }

      const res = await fetch('/api/generate/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positivePrompt: p.positivePrompt,
          negativePrompt: p.negativePrompt,
          ...(triggerWords.length > 0 && { triggerWords }),
        }),
      });
      const data = await res.json() as { positive?: string; negative?: string; error?: string };
      if (!res.ok || data.error) {
        const msg = data.error ?? `Error ${res.status}`;
        setPolishError(msg);
        polishErrorTimer.current = setTimeout(() => setPolishError(null), 5000);
        return;
      }
      if (data.positive) update('positivePrompt', data.positive);
      if (data.negative) update('negativePrompt', data.negative);
    } catch (err) {
      const msg = String(err);
      setPolishError(msg);
      polishErrorTimer.current = setTimeout(() => setPolishError(null), 5000);
    } finally {
      setPolishing(false);
    }
  }

  // ── Video validation ──────────────────────────────────────────────────────

  const vWidthErr = !Number.isInteger(videoP.width) || videoP.width < 256 || videoP.width > 1280 || videoP.width % 32 !== 0;
  const vHeightErr = !Number.isInteger(videoP.height) || videoP.height < 256 || videoP.height > 1280 || videoP.height % 32 !== 0;
  const vFramesErr = !Number.isInteger(videoP.frames) || videoP.frames < 17 || videoP.frames > 121 || (videoP.frames - 1) % 8 !== 0;
  const vStepsErr = !Number.isInteger(videoP.steps) || videoP.steps < 4 || videoP.steps > 40 || videoP.steps % 2 !== 0;
  const vCfgErr = videoP.cfg < 1.0 || videoP.cfg > 10.0;
  const videoGenerateDisabled =
    !p.positivePrompt.trim()
    || vWidthErr || vHeightErr || vFramesErr || vStepsErr || vCfgErr
    // Gallery picker (non-project): starting frame toggle On but no record selected
    || (!selectedStartingClipId && useStartingFrame && !startingFrameRecord)
    || extractingLastFrame;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 space-y-4">

      {/* ── Studio header: mode toggle + queue tray ── */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 bg-zinc-800 rounded-xl p-1 gap-1">
          {(['image', 'video'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`flex-1 min-h-12 rounded-lg font-medium text-sm transition-all
                ${mode === m
                  ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {m === 'image' ? 'Image' : 'Video'}
            </button>
          ))}
        </div>
        <QueueTray onNavigateToGallery={onNavigateToGallery} />
      </div>

      {/* ── Project context badge / picker ── */}
      {projectContext ? (
        /* State B: project active */
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-600/10 border border-violet-600/20">
          <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <button
            type="button"
            onClick={() => setShowProjectPicker(true)}
            disabled={switchingProject}
            className="text-xs font-medium text-violet-300 flex-1 truncate text-left min-h-8 hover:text-violet-200 transition-colors disabled:opacity-70"
          >
            {switchingProject ? 'Switching…' : `Project: ${projectContext.projectName}`}
          </button>
          <button
            type="button"
            onClick={clearProjectContext}
            aria-label="Clear project context"
            className="min-h-8 min-w-8 flex items-center justify-center rounded-lg text-violet-400 hover:text-violet-200 hover:bg-violet-500/20 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        /* State A: no project */
        <button
          type="button"
          onClick={() => setShowProjectPicker(true)}
          disabled={switchingProject}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-70 transition-colors w-full min-h-12"
        >
          <svg className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="text-xs font-medium text-zinc-400 flex-1 truncate text-left">
            {switchingProject ? 'Switching…' : 'No project'}
          </span>
        </button>
      )}

      {/* ── After image generation: thumbnail grid ── */}
      {mode === 'image' && lastImageRecords.length > 0 && (
        <div className="card">
          <div className="grid grid-cols-3 gap-1.5">
            {lastImageRecords.map((rec, i) => (
              <div
                key={rec.id}
                className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <button
                  className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  onClick={() => { setModalStartIdx(i); setModalOpen(true); }}
                  aria-label={`View generation ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imgSrc(rec.filePath)} alt="Generated" className="w-full h-full object-cover" />
                </button>
              </div>
            ))}
          </div>
          {lastResolvedSeed !== -1 && (
            <p className="text-xs text-zinc-400 mt-2 tabular-nums">Seed: {lastResolvedSeed}</p>
          )}
        </div>
      )}

      {/* ── After video generation: thumbnail grid ── */}
      {mode === 'video' && lastVideoResults.length > 0 && (
        <div className="card">
          <div className="grid grid-cols-3 gap-1.5">
            {lastVideoResults.map((rec, i) => (
              <div
                key={rec.id}
                className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <button
                  className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  onClick={() => { setVideoModalIdx(i); setVideoModalOpen(true); }}
                  aria-label={`View video ${i + 1}`}
                >
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={imgSrc(rec.filePath)}
                    preload="metadata"
                    muted
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {rec.frames != null && rec.fps != null && (
                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] text-white tabular-nums pointer-events-none">
                      {(rec.frames / rec.fps).toFixed(1)}s
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>
          {lastVideoResults.length === 1 && (
            <p className="text-xs text-zinc-400 mt-2 tabular-nums">Seed: {lastVideoResults[0].seed}</p>
          )}
        </div>
      )}

      {/* ── Submit error (network/validation failures before job starts) ── */}
      {submitError && (
        <div className="card border-red-900 bg-red-950/30">
          <p className="text-red-400 text-sm">{submitError}</p>
        </div>
      )}

      {/* ── Prompts ── */}
      <div className="card space-y-3">
        <PromptArea
          label="Positive Prompt"
          value={p.positivePrompt}
          onChange={(v) => update('positivePrompt', v)}
          placeholder={mode === 'video'
            ? 'A serene mountain lake at dawn, mist rising, cinematic, realistic.'
            : 'A dog sunning itself on a shag rug.'}
          rows={4}
          hint={mode === 'image' ? (checkpointDefaults?.positivePrompt || undefined) : undefined}
        />
        {mode === 'image' ? (
          <PromptArea
            label="Negative Prompt"
            value={p.negativePrompt}
            onChange={(v) => update('negativePrompt', v)}
            rows={2}
            hint={checkpointDefaults?.negativePrompt || undefined}
          />
        ) : (
          <p className="text-xs text-zinc-500 pt-1">Default Wan 2.2 negative prompt applied.</p>
        )}
      </div>

      {/* ── Image mode: Reference panel ── */}
      {mode === 'image' && (
        <ReferencePanel
          baseImage={baseImage}
          mask={mask}
          baseImageDenoise={baseImageDenoise}
          faceReferences={faceReferences}
          faceStrength={faceStrength}
          selectedCheckpoint={p.checkpoint}
          checkpointConfigs={checkpointConfig ? [checkpointConfig] : []}
          onBaseImageChange={setBaseImage}
          onMaskChange={setMask}
          onBaseImageDenoiseChange={setBaseImageDenoise}
          onFaceReferencesChange={setFaceReferences}
          onFaceStrengthChange={setFaceStrength}
        />
      )}

      {/* ── Video mode: Starting frame (I2V) ── */}
      {mode === 'video' && (
        <div className="card space-y-3">

          {/* Project frame picker — replaces the old "use last frame" checkbox */}
          {projectContext?.latestClipId && (
            <div>
              <label className="label mb-2 block">Starting frame (I2V)</label>
              {selectedStartingClipId && pickerItems.length > 0 ? (
                // Selection active — show thumbnail + Change + ×
                <div className="flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    {(() => {
                      const item = pickerItems.find((pi) => pi.id === selectedStartingClipId);
                      if (!item) return <div className="w-24 h-24 rounded-lg bg-zinc-800 border border-zinc-700" />;
                      const cachedFrame = item.mediaType === 'video' ? frameCache.current.get(item.id) : undefined;
                      if (item.mediaType === 'image') {
                        // eslint-disable-next-line @next/next/no-img-element
                        return <img src={imgSrc(item.filePath)} alt="Starting frame" className="w-24 h-24 rounded-lg object-cover border border-zinc-700" />;
                      } else if (cachedFrame) {
                        // eslint-disable-next-line @next/next/no-img-element
                        return <img src={cachedFrame} alt="Starting frame" className="w-24 h-24 rounded-lg object-cover border border-zinc-700" />;
                      } else {
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        return <video src={imgSrc(item.filePath)} preload="metadata" muted playsInline className="w-24 h-24 rounded-lg object-cover border border-zinc-700" />;
                      }
                    })()}
                    <button
                      type="button"
                      onClick={() => setSelectedStartingClipId(null)}
                      aria-label="Clear starting frame"
                      className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-zinc-800 border border-zinc-600 rounded-full flex items-center justify-center text-zinc-300 hover:bg-red-600 hover:text-white transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openFramePicker()}
                    disabled={pickerFetching}
                    className="min-h-12 px-4 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 active:scale-95 transition-all disabled:opacity-50"
                  >
                    Change
                  </button>
                </div>
              ) : (
                // No selection — "Choose starting frame" button
                <button
                  type="button"
                  onClick={() => void openFramePicker()}
                  disabled={pickerFetching}
                  className="w-full min-h-14 rounded-xl border-2 border-dashed border-zinc-700 hover:border-violet-600/60 hover:bg-violet-600/5 transition-colors flex items-center justify-center gap-2 text-zinc-400 hover:text-zinc-200 text-sm disabled:opacity-50"
                >
                  {pickerFetching ? (
                    <svg className="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                    </svg>
                  )}
                  {pickerFetching ? 'Loading clips…' : 'Choose starting frame'}
                </button>
              )}
            </div>
          )}

          {/* I2V toggle + gallery picker — for non-project use only */}
          {!projectContext && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="label mb-0">Starting frame (I2V)</label>
                <button
                  type="button"
                  onClick={() => {
                    const next = !useStartingFrame;
                    setUseStartingFrame(next);
                    if (!next) setStartingFrameRecord(null);
                  }}
                  className={`min-h-12 px-4 rounded-lg text-sm font-medium transition-all border
                    ${useStartingFrame
                      ? 'bg-violet-600/20 text-violet-300 border-violet-700/50'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
                >
                  {useStartingFrame ? 'On' : 'Off'}
                </button>
              </div>

              {useStartingFrame && (
                startingFrameRecord ? (
                  <div className="flex items-center gap-3">
                    <div className="relative flex-shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgSrc(startingFrameRecord.filePath)}
                        alt="Starting frame"
                        className="w-20 h-20 rounded-lg object-cover border border-zinc-700"
                      />
                      <button
                        type="button"
                        onClick={() => setStartingFrameRecord(null)}
                        aria-label="Clear starting frame"
                        className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-zinc-800 border border-zinc-600 rounded-full flex items-center justify-center text-zinc-300 hover:bg-red-600 hover:text-white transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setGalleryPickerOpen(true)}
                      className="min-h-12 px-4 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 active:scale-95 transition-all"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setGalleryPickerOpen(true)}
                    className="w-full min-h-14 rounded-xl border-2 border-dashed border-zinc-700 hover:border-violet-600/60 hover:bg-violet-600/5 transition-colors flex items-center justify-center gap-2 text-zinc-400 hover:text-zinc-200 text-sm"
                  >
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                    </svg>
                    Pick from gallery
                  </button>
                )
              )}
            </div>
          )}

        </div>
      )}

      {/* ── Bottom bar ── */}
      <div
        className="fixed bottom-0 left-0 right-0 px-4 pt-3 bg-zinc-950/90 backdrop-blur border-t border-zinc-800 z-30 max-w-2xl mx-auto transition-transform duration-150 ease-out"
        style={{
          transform: `translateY(-${keyboardOffset}px)`,
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        {mode === 'image' ? (
          <>
            {polishError && (
              <p className="text-xs text-red-400 mb-2 truncate">✨ {polishError}</p>
            )}
            <div className="flex gap-3">
              {/* Settings */}
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open settings"
                className="min-h-12 min-w-14 flex flex-col items-center justify-center gap-0.5 rounded-xl
                           bg-zinc-800 hover:bg-zinc-700 active:scale-95
                           border border-zinc-700 text-zinc-300 transition-all flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
                </svg>
              </button>

              {/* Polish */}
              <button
                type="button"
                onClick={() => void handlePolish()}
                disabled={polishing || !p.positivePrompt.trim()}
                aria-label="Polish prompts with AI"
                className="min-h-12 min-w-14 flex flex-col items-center justify-center rounded-xl
                           bg-violet-600/10 hover:bg-violet-600/20 active:scale-95
                           border border-violet-600/30 hover:border-violet-500/50
                           text-violet-300 transition-all flex-shrink-0
                           disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                {polishing ? (
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                  </svg>
                ) : (
                  <span className="text-lg leading-none">✨</span>
                )}
              </button>

              {/* Generate — image mode (always enabled when checkpoint is selected) */}
              <button
                onClick={() => void handleGenerate()}
                disabled={!p.checkpoint || submitting}
                className="flex-1 py-4 rounded-xl font-semibold text-base transition-all
                           bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                           disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                           text-white shadow-lg shadow-violet-900/40"
              >
                {p.batchSize > 1 ? `Generate ×${p.batchSize}` : 'Generate'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex gap-3">
            {/* Settings — video mode */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open settings"
              className="min-h-12 min-w-14 flex flex-col items-center justify-center gap-0.5 rounded-xl
                         bg-zinc-800 hover:bg-zinc-700 active:scale-95
                         border border-zinc-700 text-zinc-300 transition-all flex-shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
              </svg>
            </button>

            {/* Generate — video mode */}
            <button
              onClick={() => void handleGenerateVideo()}
              disabled={videoGenerateDisabled || submitting}
              className="flex-1 py-4 rounded-xl font-semibold text-base transition-all
                         bg-violet-600 hover:bg-violet-500 active:scale-[0.98]
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                         text-white shadow-lg shadow-violet-900/40"
            >
              {videoBatchSize > 1 ? `Generate Video ×${videoBatchSize}` : 'Generate Video'}
            </button>
          </div>
        )}
      </div>

      {/* ── Drawer overlay ── */}
      <div
        className={`fixed inset-0 bg-black/60 z-40 transition-opacity duration-300
          ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* ── Settings drawer ── */}
      <div
        className={`fixed top-0 right-0 bottom-0 w-80 max-w-[90vw] z-50 flex flex-col
                    bg-zinc-900 border-l border-zinc-800
                    transition-transform duration-300 ease-in-out
                    ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}
        aria-label="Generation settings"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close settings"
            className="min-h-12 min-w-12 flex items-center justify-center rounded-xl
                       text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">

          {mode === 'image' ? (
            <>
              <div className="px-4 pt-4 pb-5">
                <p className="label mb-3">Models</p>
                <ModelSelect
                  checkpoint={p.checkpoint}
                  loras={p.loras}
                  onCheckpointChange={handleCheckpointChange}
                  onInitialCheckpoint={handleInitialCheckpoint}
                  onLorasChange={(v) => update('loras', v)}
                  refreshToken={modelConfigVersion}
                />
              </div>

              <div className="border-t border-zinc-800" />

              <div className="px-4 pt-4 pb-5 space-y-4">
                <p className="label">Generation</p>
                <ParamSlider label="Steps" value={p.steps} min={1} max={100} step={1} onChange={(v) => update('steps', v)} />
                <ParamSlider label="CFG Scale" value={p.cfg} min={1} max={20} step={0.5} onChange={(v) => update('cfg', v)} format={(v) => v.toFixed(1)} />
                <ParamSlider label="Batch Size" value={p.batchSize} min={1} max={4} step={1} onChange={(v) => update('batchSize', v)} />
                <div>
                  <label className="label">High-Res Fix</label>
                  <button
                    type="button"
                    onClick={() => update('highResFix', !p.highResFix)}
                    className={`min-h-12 w-full rounded-lg text-sm font-medium transition-all border
                      ${p.highResFix
                        ? 'bg-violet-600/20 text-violet-300 border-violet-700/50'
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
                  >
                    {p.highResFix ? 'HRF On — 2× Upscale' : 'HRF Off'}
                  </button>
                </div>
              </div>

              <div className="border-t border-zinc-800" />

              <div className="px-4 pt-4 pb-5 space-y-3">
                <p className="label">Sampling</p>
                <div>
                  <label className="label">Resolution</label>
                  <select
                    value={`${p.width}x${p.height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split('x').map(Number);
                      update('width', w);
                      update('height', h);
                    }}
                    className="input-base"
                  >
                    {RESOLUTIONS.map((r) => (
                      <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Sampler</label>
                  <select value={p.sampler} onChange={(e) => update('sampler', e.target.value)} className="input-base">
                    {SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Scheduler</label>
                  <select value={p.scheduler} onChange={(e) => update('scheduler', e.target.value)} className="input-base">
                    {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="border-t border-zinc-800" />

              <div className="px-4 pt-4 pb-8">
                <label className="label">Seed</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={p.seed}
                    onChange={(e) => update('seed', parseInt(e.target.value, 10))}
                    className="input-base flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => update('seed', -1)}
                    disabled={p.seed === -1}
                    title={p.seed === -1 ? 'Random mode active' : 'Reset to random'}
                    className={`min-h-12 px-4 rounded-lg text-sm font-medium transition-all flex-shrink-0 border
                      ${p.seed === -1
                        ? 'bg-violet-600/20 text-violet-300 border-violet-700/50 cursor-default'
                        : 'bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
                  >
                    {p.seed === -1 ? '🎲 Random' : '🎲 Randomize'}
                  </button>
                </div>
                {lastResolvedSeed !== -1 && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-zinc-400 tabular-nums">Last seed: {lastResolvedSeed}</span>
                    <button
                      type="button"
                      onClick={() => update('seed', lastResolvedSeed)}
                      className="min-h-12 px-4 rounded-lg text-sm font-medium transition-all flex-shrink-0 border bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 active:scale-95"
                    >
                      ♻ Reuse
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* ── Lightning toggle — top of video settings ── */}
              <div className="px-4 pt-4 pb-4 border-b border-zinc-800">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={lightning}
                    onClick={() => setLightningAndPersist(!lightning)}
                    className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors mt-0.5
                      ${lightning ? 'bg-amber-500' : 'bg-zinc-700'}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform
                        ${lightning ? 'translate-x-6' : 'translate-x-0'}`}
                    />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-100 leading-tight">
                      Lightning{lightning ? ' ⚡' : ''}
                    </p>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {lightning
                        ? '4 steps · CFG 1 · ~3 min · Steps and CFG locked'
                        : '4 steps, ~3 min. Steps and CFG locked.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* ── Video LoRA stack ── */}
              <div className="px-4 pt-4 pb-4 border-b border-zinc-800">
                <VideoLoraStack
                  loras={videoLoras}
                  lists={modelLists}
                  onChange={setVideoLorasAndPersist}
                />
                {lightning && videoLoras.length > 0 && (
                  <p className="text-xs text-amber-400/80 mt-2">
                    Lightning + LoRA stack: experimental — Lightning was distilled against the bare base model.
                  </p>
                )}
              </div>

              <div className="px-4 pt-4 pb-5 space-y-3">
                <p className="label">Resolution</p>
                <div className="flex gap-2">
                  {VIDEO_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => { updateVideo('width', preset.w); updateVideo('height', preset.h); }}
                      className={`flex-1 min-h-12 rounded-lg text-xs font-medium border transition-all
                        ${videoP.width === preset.w && videoP.height === preset.h
                          ? 'bg-violet-600/20 text-violet-300 border-violet-700/50'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-zinc-200 active:scale-95'}`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Width</label>
                    <input
                      type="number"
                      value={videoP.width}
                      min={256}
                      max={1280}
                      step={32}
                      onChange={(e) => updateVideo('width', parseInt(e.target.value, 10))}
                      className={`input-base ${vWidthErr ? 'border-red-500' : ''}`}
                    />
                    {vWidthErr && <p className="text-xs text-red-400 mt-1">Multiple of 32, 256–1280</p>}
                  </div>
                  <div>
                    <label className="label">Height</label>
                    <input
                      type="number"
                      value={videoP.height}
                      min={256}
                      max={1280}
                      step={32}
                      onChange={(e) => updateVideo('height', parseInt(e.target.value, 10))}
                      className={`input-base ${vHeightErr ? 'border-red-500' : ''}`}
                    />
                    {vHeightErr && <p className="text-xs text-red-400 mt-1">Multiple of 32, 256–1280</p>}
                  </div>
                </div>
              </div>

              <div className="border-t border-zinc-800" />

              <div className="px-4 pt-4 pb-5 space-y-4">
                <p className="label">Generation</p>
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="label mb-0">Frames</label>
                    <span className="text-xs text-zinc-400 tabular-nums font-mono">
                      {videoP.frames} frames ({(videoP.frames / 16).toFixed(1)}s)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={17}
                    max={121}
                    step={8}
                    value={videoP.frames}
                    onChange={(e) => updateVideo('frames', parseInt(e.target.value, 10))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-zinc-700"
                  />
                  {vFramesErr && <p className="text-xs text-red-400 mt-1">Must be 17, 25, 33, … 121</p>}
                </div>
                <div>
                  {lightning ? (
                    <div>
                      <p className="label mb-1">Steps</p>
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
                        <span className="text-sm text-amber-400 font-medium tabular-nums">4</span>
                        <span className="text-xs text-zinc-500">(locked — Lightning)</span>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <ParamSlider
                        label="Steps"
                        value={videoP.steps}
                        min={4}
                        max={40}
                        step={2}
                        onChange={(v) => updateVideo('steps', v)}
                      />
                      {vStepsErr && <p className="text-xs text-red-400 mt-1">Even number, 4–40</p>}
                    </div>
                  )}
                </div>
                <div>
                  {lightning ? (
                    <div>
                      <p className="label mb-1">CFG</p>
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
                        <span className="text-sm text-amber-400 font-medium tabular-nums">1.0</span>
                        <span className="text-xs text-zinc-500">(locked — Lightning)</span>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <ParamSlider
                        label="CFG"
                        value={videoP.cfg}
                        min={1}
                        max={10}
                        step={0.1}
                        onChange={(v) => updateVideo('cfg', Math.round(v * 10) / 10)}
                        format={(v) => v.toFixed(1)}
                      />
                      {vCfgErr && <p className="text-xs text-red-400 mt-1">1.0–10.0</p>}
                    </div>
                  )}
                </div>
                <ParamSlider
                  label="Batch"
                  value={videoBatchSize}
                  min={1}
                  max={4}
                  step={1}
                  onChange={setVideoBatchSize}
                />
              </div>

              <div className="border-t border-zinc-800" />

              <div className="px-4 pt-4 pb-8">
                <label className="label">Seed</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={p.seed}
                    onChange={(e) => update('seed', parseInt(e.target.value, 10))}
                    className="input-base flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => update('seed', -1)}
                    disabled={p.seed === -1}
                    title={p.seed === -1 ? 'Random mode active' : 'Reset to random'}
                    className={`min-h-12 px-4 rounded-lg text-sm font-medium transition-all flex-shrink-0 border
                      ${p.seed === -1
                        ? 'bg-violet-600/20 text-violet-300 border-violet-700/50 cursor-default'
                        : 'bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 active:scale-95'}`}
                  >
                    {p.seed === -1 ? '🎲 Random' : '🎲 Randomize'}
                  </button>
                </div>
              </div>
            </>
          )}

        </div>
      </div>

      {/* ── Full-screen image modal ── */}
      {modalOpen && lastImageRecords.length > 0 && (
        <ImageModal
          items={lastImageRecords}
          startIndex={modalStartIdx}
          onClose={() => setModalOpen(false)}
          onRemix={(record) => { onRemix(record); setModalOpen(false); }}
          onDelete={handleStudioDelete}
        />
      )}

      {/* ── Full-screen video result modal ── */}
      {videoModalOpen && lastVideoResults.length > 0 && (
        <ImageModal
          items={lastVideoResults}
          startIndex={videoModalIdx}
          onClose={() => setVideoModalOpen(false)}
          onRemix={(record) => { onRemix(record); setVideoModalOpen(false); }}
          onDelete={async (id) => {
            const res = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            setLastVideoResults((prev) => prev.filter((r) => r.id !== id));
            onGenerated();
          }}
        />
      )}

      {/* ── Gallery picker modal (video starting frame) ── */}
      <GalleryPicker
        open={galleryPickerOpen}
        onClose={() => setGalleryPickerOpen(false)}
        onSelect={(record) => setStartingFrameRecord(record)}
      />

      {/* ── Project frame picker modal ── */}
      <ProjectFramePickerModal
        open={framePickerOpen}
        items={pickerItems}
        loading={pickerFetching}
        initialSelectedId={selectedStartingClipId ?? projectContext?.latestClipId ?? null}
        frameCache={frameCache}
        onConfirm={(id) => { setSelectedStartingClipId(id); setFramePickerOpen(false); }}
        onClose={() => setFramePickerOpen(false)}
      />

      {/* ── Studio project picker ── */}
      <ProjectPicker
        open={showProjectPicker}
        currentProjectId={projectContext?.projectId ?? null}
        title="Switch project"
        onClose={() => setShowProjectPicker(false)}
        onSelect={(projectId, projectName) => { void handleProjectSwitch(projectId, projectName); }}
        onCreateNew={() => { setShowProjectPicker(false); setShowNewProjectModal(true); }}
      />

      {/* ── New project modal (from picker "+ Create new project") ── */}
      {showNewProjectModal && (
        <NewProjectModal
          onClose={() => setShowNewProjectModal(false)}
          onCreated={handleNewProjectCreated}
        />
      )}

    </div>
  );
}

