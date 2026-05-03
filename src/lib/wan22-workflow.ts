import t2vTemplate from './wan22-templates/wan22-t2v.json';
import i2vTemplate from './wan22-templates/wan22-i2v.json';

export type ComfyWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}>;

// Verbatim Alibaba-recommended negative prompt — do not translate or replace.
// The model was trained against this exact string.
export const WAN22_DEFAULT_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

export interface VideoParams {
  generationId: string;
  filenamePrefix: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;
  /** When true, injects lightx2v Lightning LoRAs, forces steps=4, CFG=1, sampler=lcm. */
  lightning?: boolean;
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

// Inject lightx2v Lightning LoRAs and rewire ModelSamplingSD3 nodes.
// nodes 37 (high-noise UNETLoader) and 56 (low-noise UNETLoader) are the
// existing UNET loaders. Lightning LoRAs wrap each one as nodes 100/101,
// then ModelSamplingSD3 nodes 54/55 are rewired to consume the LoRA outputs.
function applyLightning(wf: ComfyWorkflow, variant: 'wan22-lightning-t2v' | 'wan22-lightning-i2v'): void {
  wf['100'] = {
    class_type: 'LoraLoaderModelOnly',
    inputs: {
      lora_name: `${variant}/high_noise_model.safetensors`,
      strength_model: 1.0,
      model: ['37', 0],
    },
    _meta: { title: 'Lightning LoRA (high noise)' },
  };
  wf['101'] = {
    class_type: 'LoraLoaderModelOnly',
    inputs: {
      lora_name: `${variant}/low_noise_model.safetensors`,
      strength_model: 1.0,
      model: ['56', 0],
    },
    _meta: { title: 'Lightning LoRA (low noise)' },
  };

  // Rewire ModelSamplingSD3 nodes to consume LoRA outputs instead of UNETLoaders
  wf['54'].inputs.model = ['100', 0];
  wf['55'].inputs.model = ['101', 0];

  // LCM sampler required for Lightning distillation
  wf['57'].inputs.sampler_name = 'lcm';
  wf['58'].inputs.sampler_name = 'lcm';
}

export function buildT2VWorkflow(params: VideoParams): ComfyWorkflow {
  const wf = deepClone(t2vTemplate);

  // Prompts
  wf['6'].inputs.text = params.prompt;
  wf['7'].inputs.text = params.negativePrompt;

  // Dimensions and frame count (node 61 = EmptyHunyuanLatentVideo)
  wf['61'].inputs.width = params.width;
  wf['61'].inputs.height = params.height;
  wf['61'].inputs.length = params.frames;

  // Seed
  wf['57'].inputs.noise_seed = params.seed;

  if (params.lightning) {
    applyLightning(wf, 'wan22-lightning-t2v');
    applySteps(wf, 4);
    applyCfg(wf, 1);
  } else {
    applySteps(wf, params.steps);
    applyCfg(wf, params.cfg);
  }

  // SaveWEBM filename prefix — random hex string, set by the route
  wf['47'].inputs.filename_prefix = params.filenamePrefix;

  // Strip SaveAnimatedWEBP — disk write, no HTTP retrieval path, not needed
  delete wf['28'];

  return wf;
}

export function buildI2VWorkflow(params: VideoParams & { startImageB64: string }): ComfyWorkflow {
  const wf = deepClone(i2vTemplate);

  // Prompts
  wf['6'].inputs.text = params.prompt;
  wf['7'].inputs.text = params.negativePrompt;

  // Dimensions and frame count (node 50 = WanImageToVideo)
  wf['50'].inputs.width = params.width;
  wf['50'].inputs.height = params.height;
  wf['50'].inputs.length = params.frames;

  // Seed
  wf['57'].inputs.noise_seed = params.seed;

  if (params.lightning) {
    applyLightning(wf, 'wan22-lightning-i2v');
    applySteps(wf, 4);
    applyCfg(wf, 1);
  } else {
    applySteps(wf, params.steps);
    applyCfg(wf, params.cfg);
  }

  // SaveWEBM filename prefix — random hex string, set by the route
  wf['47'].inputs.filename_prefix = params.filenamePrefix;

  // Insert the base64 image loader as node 52. The template intentionally
  // omits this node; the link from node 50 (start_image) is dangling until
  // we add it here. ETN_LoadImageBase64 never writes to VM disk.
  wf['52'] = {
    class_type: 'ETN_LoadImageBase64',
    inputs: { image: stripDataUriPrefix(params.startImageB64) },
    _meta: { title: 'Load Image (Base64)' },
  };

  // Strip SaveAnimatedWEBP — disk write, no HTTP retrieval path, not needed
  delete wf['28'];

  return wf;
}
