# Wan 2.2 install — handoff to architect

Status: T2V workflow built, smoke-tested end-to-end, and exported in both formats. I2V models still downloading; workflow and smoke test will follow the same pattern.

## Models on a100-core

All in `/models/ComfyUI/models/`:

| File | Size | Path |
|---|---|---|
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | 14G | `diffusion_models/` |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | 14G | `diffusion_models/` |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 14G | `diffusion_models/` (downloading) |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 14G | `diffusion_models/` (downloading) |
| `wan_2.1_vae.safetensors` | 243M | `vae/` (used by both t2v and i2v) |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.3G | `text_encoders/` (used by both) |

Source: HuggingFace `Comfy-Org/Wan_2.2_ComfyUI_Repackaged`, fp8_scaled variants. Fetched with the `hf` CLI plus `hf_transfer`.

ComfyUI build on the VM is from April 2026, which postdates the July 2025 native Wan 2.2 support — no custom nodes needed. Confirmed via working end-to-end run.

## Workflow files

Four artifacts total once i2v is done:

- `wan22-t2v.json` — API format, for `/prompt` POSTs
- `wan22-t2v.workflow.json` — UI format, for human editing in ComfyUI
- `wan22-i2v.json` — pending
- `wan22-i2v.workflow.json` — pending

Both built from the official Comfy-Org example workflows (drag-drop, no manual node wiring), exported via Workflow → Export (API) with Dev Mode enabled.

Structurally:
- **T2V** is pure text-to-video. No LoadImage. Latent shape comes from an `EmptyHunyuanLatentVideo` node (id 61).
- **I2V** has a LoadImage (id 52) feeding a `WanImageToVideo` node (id 50), which outputs the conditioning that both samplers consume.

## Smoke test (t2v)

Ran at full defaults: 1280×704, 57 frames, 20+20 sampler steps, fp8. ~5 minutes wall time on the existing 50% A100 allocation. Output frame attached separately — quality looks fine for fp8, no visible quantization artifacts on a cyberpunk-robot test prompt.

I did not bump the GPU allocation. The current slice is comfortable; the bottleneck for fast iteration is steps and resolution, not VRAM headroom. Worth keeping the 50% cap and exposing steps/resolution as the user-facing speed knobs.

## Open questions for you

**1. Save-node strategy.** Both example workflows include `SaveAnimatedWEBP` (id 28) and `SaveWEBM` (id 47) nodes that write video files to the VM filesystem. As-is this breaks the disk-avoidance constraint. The LTX setup must already solve this — WS hijack on a `SaveVideoWebsocket`-style node, deleted save nodes, or something else. Whichever pattern wins, the wiring prompt should specify it explicitly so both Wan workflows match.

**2. I2V input-image transport.** Same problem the LTX i2v setup faces. The exported i2v JSON's LoadImage references whatever filename was loaded during smoke testing; the calling code will need to substitute at runtime. Match whatever pattern the LTX i2v path already uses, or specify a new one.

## Notes for whoever writes the wiring prompt

Three gotchas worth calling out so they don't bite the developer:

**MoE step-coupling.** The 14B model splits sampling between high-noise and low-noise experts using two `KSamplerAdvanced` nodes that share a single conceptual "total steps" value, expressed in four places that must stay in sync:

- Node 57: `steps=20, start_at_step=0, end_at_step=10`
- Node 58: `steps=20, start_at_step=10, end_at_step=10000`

If the app exposes a `steps` parameter, the override layer must write all four fields together — both `steps` to the new total, and the handoff (`57.end_at_step` and `58.start_at_step`) to half of it. Naively overriding only the two `steps` fields will leave the handoff stuck at 10 and silently break sampling at any total ≠ 20.

**Chinese negative prompt is intentional.** The default negative on node 7 is verbatim from Alibaba's recommended Wan 2.2 negative. Don't translate or replace it; the model was trained against this exact string. Worth a note in the prompt so nobody "fixes" it later.

**Parameter map** for the API override layer:

| Parameter | Node | JSON path | Notes |
|---|---|---|---|
| Positive prompt | 6 | `inputs.text` | |
| Negative prompt | 7 | `inputs.text` | Keep as default |
| Width / height | 61 (t2v), 50 (i2v) | `inputs.width`, `inputs.height` | Different node per workflow |
| Length (frames) | 61 (t2v), 50 (i2v) | `inputs.length` | Different node per workflow |
| Seed | 57 | `inputs.noise_seed` | |
| Steps (total) | 57 + 58 | see above | Four fields, not two |
| CFG | 57 + 58 | `inputs.cfg` | Currently 3.5 on both; keep in sync |
| Input image (i2v only) | 52 | LoadImage's image input | See open question 2 |

## What's next

Once i2v finishes downloading and smoke-tests clean, the four workflow files and a README with a working `curl` example for hitting `/prompt` directly will be ready to commit. After that, this is yours to scope into a wiring prompt.
