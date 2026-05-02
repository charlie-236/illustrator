import t2vTemplate from './wan22-templates/wan22-t2v.json';
import i2vTemplate from './wan22-templates/wan22-i2v.json';

export type ComfyWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}>;

export interface VideoParams {
  generationId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;
}

function deepClone(obj: unknown): ComfyWorkflow {
  return JSON.parse(JSON.stringify(obj)) as ComfyWorkflow;
}

function stripDataUriPrefix(b64: string): string {
  const idx = b64.indexOf(',');
  return idx !== -1 ? b64.slice(idx + 1) : b64;
}

// Four-field write required by MoE step coupling.
// Naively writing only `steps` leaves end_at_step/start_at_step stuck at the
// template default (10) and silently breaks sampling at any total ≠ 20.
function applySteps(wf: ComfyWorkflow, total: number): void {
  if (total % 2 !== 0) throw new Error('steps must be even');
  const handoff = total / 2;
  wf['57'].inputs.steps = total;
  wf['57'].inputs.end_at_step = handoff;
  wf['58'].inputs.steps = total;
  wf['58'].inputs.start_at_step = handoff;
}

function applyCfg(wf: ComfyWorkflow, cfg: number): void {
  wf['57'].inputs.cfg = cfg;
  wf['58'].inputs.cfg = cfg;
}

export function buildT2VWorkflow(params: VideoParams): ComfyWorkflow {
  const wf = deepClone(t2vTemplate);

  // Prompts
  wf['6'].inputs.text = params.prompt;
  if (params.negativePrompt !== undefined) {
    wf['7'].inputs.text = params.negativePrompt;
  }

  // Dimensions and frame count (node 61 = EmptyHunyuanLatentVideo)
  wf['61'].inputs.width = params.width;
  wf['61'].inputs.height = params.height;
  wf['61'].inputs.length = params.frames;

  // Seed
  wf['57'].inputs.noise_seed = params.seed;

  // MoE step coupling — four fields via helper
  applySteps(wf, params.steps);

  // CFG — both sampler nodes must stay in sync
  applyCfg(wf, params.cfg);

  // SaveWEBM filename prefix for deterministic VM-side cleanup
  wf['47'].inputs.filename_prefix = `video-${params.generationId}`;

  // Strip SaveAnimatedWEBP — disk write, no HTTP retrieval path, not needed
  delete wf['28'];

  return wf;
}

export function buildI2VWorkflow(params: VideoParams & { startImageB64: string }): ComfyWorkflow {
  const wf = deepClone(i2vTemplate);

  // Prompts
  wf['6'].inputs.text = params.prompt;
  if (params.negativePrompt !== undefined) {
    wf['7'].inputs.text = params.negativePrompt;
  }

  // Dimensions and frame count (node 50 = WanImageToVideo)
  wf['50'].inputs.width = params.width;
  wf['50'].inputs.height = params.height;
  wf['50'].inputs.length = params.frames;

  // Seed
  wf['57'].inputs.noise_seed = params.seed;

  // MoE step coupling — four fields via helper
  applySteps(wf, params.steps);

  // CFG — both sampler nodes must stay in sync
  applyCfg(wf, params.cfg);

  // SaveWEBM filename prefix for deterministic VM-side cleanup
  wf['47'].inputs.filename_prefix = `video-${params.generationId}`;

  // Replace LoadImage (writes to VM disk) with ETN_LoadImageBase64 (inline base64 — no disk write)
  wf['52'] = {
    class_type: 'ETN_LoadImageBase64',
    inputs: { image: stripDataUriPrefix(params.startImageB64) },
    _meta: { title: 'Load Image (Base64)' },
  };

  // Strip SaveAnimatedWEBP — disk write, no HTTP retrieval path, not needed
  delete wf['28'];

  return wf;
}
