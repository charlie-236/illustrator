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
  createdAt: string;
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

export interface ModelInfo {
  checkpoints: string[];
  loras: string[];
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
