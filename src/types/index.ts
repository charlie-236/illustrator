export interface LoraEntry {
  name: string;
  weight: number;
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
}

export interface GenerationRecord {
  id: string;
  filePath: string;
  promptPos: string;
  promptNeg: string;
  model: string;
  lora: string | null;
  seed: string;
  cfg: number;
  steps: number;
  width: number;
  height: number;
  sampler: string;
  scheduler: string;
  createdAt: string;
}

export interface ModelInfo {
  checkpoints: string[];
  loras: string[];
}

export type SSEEvent =
  | { type: 'progress'; value: number; max: number }
  | { type: 'complete'; imageUrl: string; generationId: string }
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
