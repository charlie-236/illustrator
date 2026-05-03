export interface LoraEntry {
  name: string;
  weight: number;
}

export interface ReferenceImageSet {
  /** Base64-encoded image data, NO data URL prefix. 1-3 entries. */
  images: string[];
  /** Master strength control mapped to FaceID weight + weight_faceidv2. Range 0.0-1.5. */
  strength: number;
}

export interface GenerationParams {
  checkpoint: string;
  loras: LoraEntry[];
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  batchSize: number;
  highResFix?: boolean;
  baseImage?: string;
  /**
   * Inpainting mask (base64, no data URL prefix).
   * White pixels mark inpaint regions, black pixels mark preserved regions.
   * Only used when baseImage is also present.
   */
  mask?: string;
  denoise?: number;
  referenceImages?: ReferenceImageSet;
}

export interface GenerationRecord {
  id: string;
  filePath: string;
  promptPos: string;
  promptNeg: string;
  model: string;
  lora: string | null;
  lorasJson: LoraEntry[] | null;
  assembledPos: string | null;
  assembledNeg: string | null;
  seed: string;
  cfg: number;
  steps: number;
  width: number;
  height: number;
  sampler: string;
  scheduler: string;
  highResFix: boolean;
  isFavorite: boolean;
  mediaType: string;
  frames: number | null;
  fps: number | null;
  projectId: string | null;
  projectName: string | null;
  isStitched: boolean;
  parentProjectId: string | null;
  parentProjectName: string | null;
  stitchedClipIds: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  styleNote: string | null;
  clipCount: number;
  coverFrame: string | null;
  coverMediaType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStitchedExport {
  id: string;
  filePath: string;
  frames: number | null;
  fps: number | null;
  createdAt: string;
  promptPos: string;
}

export interface ProjectClip {
  id: string;
  filePath: string;
  prompt: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  position: number;
  createdAt: string;
  isFavorite: boolean;
  mediaType: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  styleNote: string | null;
  defaultFrames: number | null;
  defaultSteps: number | null;
  defaultCfg: number | null;
  defaultWidth: number | null;
  defaultHeight: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointConfig {
  id: string;
  checkpointName: string;
  friendlyName: string;
  baseModel: string;
  defaultWidth: number;
  defaultHeight: number;
  defaultPositivePrompt: string;
  defaultNegativePrompt: string;
  description?: string | null;
  url?: string | null;
  // Per-checkpoint generation defaults (null = not set, leave Studio form alone)
  defaultSteps?: number | null;
  defaultCfg?: number | null;
  defaultSampler?: string | null;
  defaultScheduler?: string | null;
  defaultHrf?: boolean | null;
}

export interface LoraConfig {
  id: string;
  loraName: string;
  friendlyName: string;
  triggerWords: string;
  baseModel: string;
  description?: string | null;
  url?: string | null;
}

export interface EmbeddingConfig {
  id: string;
  embeddingName: string;
  friendlyName: string;
  triggerWords: string;
  baseModel: string;
  category?: string | null;
  description?: string | null;
  url?: string | null;
}

export interface ModelInfo {
  checkpoints: string[];
  loras: string[];
  embeddings: string[];
}

/** Project context passed from Projects tab to Studio when generating a new clip. */
export interface ProjectContext {
  projectId: string;
  projectName: string;
  /** ID of the most-recently-positioned clip (for last-frame extraction). Null if project has no clips. */
  latestClipId: string | null;
  /** Positive prompt of the latest clip (for carry-forward). Null if project has no clips. */
  latestClipPrompt: string | null;
  /** Media type of the latest clip ('image' | 'video'). Null if project has no clips. */
  latestClipMediaType: string | null;
  /** filePath of the latest clip (used when latest is an image to use it directly). Null if project has no clips. */
  latestClipFilePath: string | null;
  defaults: {
    frames: number | null;
    steps: number | null;
    cfg: number | null;
    width: number | null;
    height: number | null;
  };
}

/** Params passed from Gallery to Studio when remixing a video generation. */
export interface VideoRemixData {
  positivePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
}

export type SSEEvent =
  | { type: 'progress'; value: number; max: number }
  | { type: 'complete'; records: GenerationRecord[] }
  | { type: 'error'; message: string };

export const SAMPLERS = [
  'euler',
  'euler_ancestral',
  'dpm_2',
  'dpm_2_ancestral',
  'dpmpp_2m',
  'dpmpp_sde',
  'dpmpp_2m_sde',
  'ddim',
  'lms',
  'uni_pc',
] as const;

export const SCHEDULERS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'beta',
] as const;

export const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×512', w: 768, h: 512 },
  { label: '768×1024', w: 768, h: 1024 },
  { label: '1024×768', w: 1024, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '1024×1536', w: 1024, h: 1536 },
  { label: '1536×1024', w: 1536, h: 1024 },
] as const;
