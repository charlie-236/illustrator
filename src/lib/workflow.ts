import type { GenerationParams } from '@/types';

function strengthToWeights(strength: number): { weight: number; weight_faceidv2: number } {
  const clamped = Math.max(0, Math.min(1.5, strength));
  if (clamped <= 1.0) {
    return { weight: 0.85 * clamped, weight_faceidv2: 0.75 * clamped };
  }
  const t = (clamped - 1.0) / 0.5;
  return {
    weight: 0.85 + (1.0 - 0.85) * t,
    weight_faceidv2: 0.75 + (1.0 - 0.75) * t,
  };
}

export function buildWorkflow(
  params: GenerationParams,
): { workflow: Record<string, unknown>; resolvedSeed: number } {
  const seed = params.seed === -1
    ? Math.floor(Math.random() * 2 ** 32)
    : params.seed;

  const nodes: Record<string, unknown> = {};

  nodes['1'] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: params.checkpoint },
  };

  let latentRef: [string, number];

  if (params.baseImage) {
    // Embed image inline — no disk write on remote. Strip data URL prefix if present.
    const commaIdx = params.baseImage.indexOf(',');
    const b64 = commaIdx !== -1 ? params.baseImage.slice(commaIdx + 1) : params.baseImage;
    nodes['10'] = {
      class_type: 'ETN_LoadImageBase64',
      inputs: { image: b64 },
    };

    if (params.mask) {
      // Inpainting mode: load mask inline + VAEEncodeForInpaint
      const maskCommaIdx = params.mask.indexOf(',');
      const maskB64 = maskCommaIdx !== -1 ? params.mask.slice(maskCommaIdx + 1) : params.mask;
      nodes['12'] = {
        class_type: 'ETN_LoadMaskBase64',
        inputs: { mask: maskB64 },
      };
      nodes['11'] = {
        class_type: 'VAEEncodeForInpaint',
        inputs: {
          pixels: ['10', 0],
          vae: ['1', 2],
          mask: ['12', 0],
          grow_mask_by: 6,
        },
      };
    } else {
      // Plain img2img: regular VAEEncode
      nodes['11'] = {
        class_type: 'VAEEncode',
        inputs: { pixels: ['10', 0], vae: ['1', 2] },
      };
    }

    latentRef = ['11', 0];
  } else {
    nodes['2'] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize ?? 1 },
    };
    latentRef = ['2', 0];
  }

  let modelRef: [string, number] = ['1', 0];
  let clipRef: [string, number] = ['1', 1];

  // Chain LoRA nodes starting at ID 100 to avoid colliding with core node IDs.
  params.loras.forEach((entry, i) => {
    const id = String(100 + i);
    nodes[id] = {
      class_type: 'LoraLoader',
      _meta: { title: `LoRA: ${entry.friendlyName ?? '(unknown LoRA)'}` },
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

  // IP-Adapter FaceID chain — nodes 300+. Injected after LoRAs so LoRAs apply first.
  if (params.referenceImages && params.referenceImages.images.length > 0) {
    const refs = params.referenceImages;
    if (refs.images.length > 3) {
      throw new Error('referenceImages.images cannot exceed 3 entries');
    }

    // One ETN_LoadImageBase64 per reference (base64 inline — no disk write on remote)
    const loadNodeIds: string[] = [];
    refs.images.forEach((b64, idx) => {
      const nodeId = String(300 + idx); // 300, 301, 302
      nodes[nodeId] = {
        class_type: 'ETN_LoadImageBase64',
        inputs: { image: b64 },
      };
      loadNodeIds.push(nodeId);
    });

    // ImageBatch chains reference images together (only needed for 2+ refs)
    let faceIdImageSource: [string, number];
    if (loadNodeIds.length === 1) {
      faceIdImageSource = [loadNodeIds[0], 0];
    } else if (loadNodeIds.length === 2) {
      nodes['310'] = {
        class_type: 'ImageBatch',
        inputs: { image1: [loadNodeIds[0], 0], image2: [loadNodeIds[1], 0] },
      };
      faceIdImageSource = ['310', 0];
    } else {
      nodes['310'] = {
        class_type: 'ImageBatch',
        inputs: { image1: [loadNodeIds[0], 0], image2: [loadNodeIds[1], 0] },
      };
      nodes['311'] = {
        class_type: 'ImageBatch',
        inputs: { image1: ['310', 0], image2: [loadNodeIds[2], 0] },
      };
      faceIdImageSource = ['311', 0];
    }

    nodes['320'] = {
      class_type: 'IPAdapterUnifiedLoaderFaceID',
      inputs: {
        preset: 'FACEID PLUS V2',
        lora_strength: 0.6,
        provider: 'CPU',
        model: modelRef,
      },
    };

    const { weight, weight_faceidv2 } = strengthToWeights(refs.strength);
    nodes['321'] = {
      class_type: 'IPAdapterFaceID',
      inputs: {
        weight,
        weight_faceidv2,
        weight_type: 'style transfer',
        combine_embeds: 'concat',
        start_at: 0,
        end_at: 1,
        embeds_scaling: 'V only',
        model: ['320', 0],
        ipadapter: ['320', 1],
        image: faceIdImageSource,
      },
    };

    modelRef = ['321', 0];
  }

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
      latent_image: latentRef,
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: params.baseImage ? (params.denoise ?? 0.65) : 1.0,
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

  return { workflow: nodes, resolvedSeed: seed };
}
