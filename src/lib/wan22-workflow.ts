import t2vTemplate from './wan22-templates/wan22-t2v.json';
import i2vTemplate from './wan22-templates/wan22-i2v.json';

type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
};

export type ComfyWorkflow = Record<string, ComfyNode>;

export interface VideoParams {
  generationId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;   // multiple of 32, 256–1280
  height: number;  // multiple of 32, 256–1280
  frames: number;  // (frames - 1) % 8 === 0, 17–121
  steps: number;   // even, 4–40
  cfg: number;
  seed: number;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function stripDataUriPrefix(b64: string): string {
  const idx = b64.indexOf(',');
  return idx !== -1 ? b64.slice(idx + 1) : b64;
}

// MoE step coupling — four fields, one helper.
// Naively writing only `steps` leaves the handoff stuck at 10 and silently
// breaks sampling at any total ≠ 20. This helper makes the write atomic.
function applySteps(wf: ComfyWorkflow, total: number): void {
  if (total % 2 !== 0) throw new Error('steps must be even');
  const handoff = total / 2;
  wf['57'].inputs.steps = total;
  wf['57'].inputs.end_at_step = handoff;
  wf['58'].inputs.steps = total;
  wf['58'].inputs.start_at_step = handoff;
}

export function buildT2VWorkflow(params: VideoParams): ComfyWorkflow {
  const wf = deepClone(t2vTemplate) as ComfyWorkflow;

  wf['6'].inputs.text = params.prompt;
  if (params.negativePrompt !== undefined) {
    wf['7'].inputs.text = params.negativePrompt;
  }

  // Node 61: EmptyHunyuanLatentVideo — dimensions and frame count
  wf['61'].inputs.width = params.width;
  wf['61'].inputs.height = params.height;
  wf['61'].inputs.length = params.frames;

  wf['57'].inputs.noise_seed = params.seed;

  // filename_prefix drives SSH cleanup glob: rm -f /output/video-${generationId}*
  wf['47'].inputs.filename_prefix = `video-${params.generationId}`;

  applySteps(wf, params.steps);

  // CFG must be in sync on both sampler nodes (MoE two-stage split)
  wf['57'].inputs.cfg = params.cfg;
  wf['58'].inputs.cfg = params.cfg;

  // Strip the second save node — SaveWEBM (node 47) is the only allowed disk write
  delete wf['28'];

  return wf;
}

export function buildI2VWorkflow(params: VideoParams & { startImageB64: string }): ComfyWorkflow {
  const wf = deepClone(i2vTemplate) as ComfyWorkflow;

  wf['6'].inputs.text = params.prompt;
  if (params.negativePrompt !== undefined) {
    wf['7'].inputs.text = params.negativePrompt;
  }

  // Node 50: WanImageToVideo — dimensions and frame count
  wf['50'].inputs.width = params.width;
  wf['50'].inputs.height = params.height;
  wf['50'].inputs.length = params.frames;

  wf['57'].inputs.noise_seed = params.seed;
  wf['47'].inputs.filename_prefix = `video-${params.generationId}`;

  applySteps(wf, params.steps);

  wf['57'].inputs.cfg = params.cfg;
  wf['58'].inputs.cfg = params.cfg;

  // Replace LoadImage with ETN_LoadImageBase64 — no disk write on VM.
  // ETN_LoadImageBase64 is already used by the image path (workflow.ts).
  wf['52'] = {
    class_type: 'ETN_LoadImageBase64',
    inputs: { image: stripDataUriPrefix(params.startImageB64) },
    _meta: { title: 'Load Image (Base64)' },
  };

  delete wf['28'];

  return wf;
}
