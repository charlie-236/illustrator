import type { GenerationParams } from '@/types';

export function buildWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = params.seed === -1
    ? Math.floor(Math.random() * 2 ** 32)
    : params.seed;

  const nodes: Record<string, unknown> = {};

  nodes['1'] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: params.checkpoint },
  };

  nodes['2'] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: params.width, height: params.height, batch_size: params.batchSize ?? 1 },
  };

  let modelRef: [string, number] = ['1', 0];
  let clipRef: [string, number] = ['1', 1];

  // Chain LoRA nodes starting at ID 100 to avoid colliding with core node IDs.
  params.loras.forEach((entry, i) => {
    const id = String(100 + i);
    nodes[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: modelRef,
        clip: clipRef,
        lora_name: entry.name,
        strength_model: entry.weight,
        strength_clip: entry.weight,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  });

  nodes['3'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: params.positivePrompt, clip: clipRef },
  };

  nodes['4'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: params.negativePrompt, clip: clipRef },
  };

  nodes['5'] = {
    class_type: 'KSampler',
    inputs: {
      model: modelRef,
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['2', 0],
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: 1.0,
    },
  };

  let vaeInput: [string, number] = ['5', 0];

  if (params.highResFix) {
    nodes['8'] = {
      class_type: 'LatentUpscaleBy',
      inputs: { samples: ['5', 0], upscale_method: 'nearest-exact', scale_by: 2.0 },
    };
    nodes['9'] = {
      class_type: 'KSampler',
      inputs: {
        model: modelRef,
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['8', 0],
        seed,
        steps: params.steps,
        cfg: params.cfg,
        sampler_name: params.sampler,
        scheduler: params.scheduler,
        denoise: 0.55,
      },
    };
    vaeInput = ['9', 0];
  }

  nodes['6'] = {
    class_type: 'VAEDecode',
    inputs: { samples: vaeInput, vae: ['1', 2] },
  };

  // SaveImageWebsocket sends image over WS without writing to remote disk
  nodes['7'] = {
    class_type: 'SaveImageWebsocket',
    inputs: { images: ['6', 0] },
  };

  return nodes;
}

export function extractSeedFromWorkflow(workflow: Record<string, unknown>): number {
  const sampler = workflow['5'] as { inputs?: { seed?: number } } | undefined;
  return sampler?.inputs?.seed ?? -1;
}
