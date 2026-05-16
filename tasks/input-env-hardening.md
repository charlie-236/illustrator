# Batch — Fail closed on missing SSH env vars + validate /api/generate body

Two small hardening changes that make failure modes loud.

1. `src/lib/civitaiIngest.ts` and `src/app/api/models/[id]/route.ts` both had hardcoded fallbacks for `A100_VM_IP` and `A100_VM_USER`. If `.env` is misconfigured these defaults silently work, masking the misconfiguration. We already have the right pattern for `IMAGE_OUTPUT_DIR` (return 500 / fail loudly when unset). Apply the same pattern.
2. `/api/generate` validates `mask` and `referenceImages` carefully but does no shape validation on `params.checkpoint`, `params.steps`, `params.width`, `params.height`, `params.cfg`, `params.seed`, `params.sampler`, `params.scheduler`, `params.batchSize`. Bad values silently get forwarded to ComfyUI which complains in obscure ways. Add lightweight inline validation — no new dependencies.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Task 1 — Fail closed on missing SSH env vars

### `src/lib/civitaiIngest.ts`

Currently at the top:

```ts
const VM_USER = process.env.A100_VM_USER ?? '<your-vm-user>';
const VM_IP = process.env.A100_VM_IP ?? '<gpu-vm-ip>';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';
```

Match the existing `SSH_KEY_PATH` pattern: empty-string fallback (so the type stays `string`), then early-return with an error event if empty. Apply the same shape to `VM_USER` and `VM_IP`:

```ts
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';
```

Inside `ingestModel`, after the existing `if (!SSH_KEY_PATH)` and `if (!CIVITAI_TOKEN)` checks, add:

```ts
if (!VM_USER) {
  yield { phase: 'error', message: 'A100_VM_USER not configured' };
  return;
}
if (!VM_IP) {
  yield { phase: 'error', message: 'A100_VM_IP not configured' };
  return;
}
```

This keeps the existing pattern uniform — every required env var has both a `?? ''` fallback and a runtime check.

### `src/app/api/models/[id]/route.ts`

Same shape — keep the `?? ''` fallback at the top of the file, and add explicit checks at the start of the DELETE handler (right next to the existing `SSH_KEY_PATH` check):

```ts
const VM_USER = process.env.A100_VM_USER ?? '';
const VM_IP = process.env.A100_VM_IP ?? '';
const SSH_KEY_PATH = process.env.A100_SSH_KEY_PATH ?? '';

// Inside DELETE, augmenting the existing SSH_KEY_PATH check:
if (!SSH_KEY_PATH) {
  return NextResponse.json({ error: 'A100_SSH_KEY_PATH not configured' }, { status: 500 });
}
if (!VM_USER) {
  return NextResponse.json({ error: 'A100_VM_USER not configured' }, { status: 500 });
}
if (!VM_IP) {
  return NextResponse.json({ error: 'A100_VM_IP not configured' }, { status: 500 });
}
```

No `.env.example` changes needed — it already lists `A100_VM_USER` and `A100_VM_IP`. AGENTS.md forbids modifying `.env`-related files. The user's actual `.env` already has these set; this change just makes a missing-env case fail loudly instead of silently using stale defaults.

---

## Task 2 — Lightweight body validation in /api/generate

Add validation BEFORE the existing `mask` / `referenceImages` validation blocks (those stay as-is). Goal: catch obviously bad params at the boundary so ComfyUI gets a clean workflow.

No new dependencies — write inline checks, returning 400 JSON responses on the first failure.

Add a small helper at the top of the route file (just inside the `POST` function, before the param read, or as a module-level helper — your call):

```ts
function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}
```

Then validate (in this order — fail on first bad value), placed immediately after the JSON parse and before the `if (params.mask)` block:

```ts
if (typeof params.checkpoint !== 'string' || params.checkpoint.length === 0) {
  return bad('checkpoint must be a non-empty string');
}
if (!Array.isArray(params.loras)) {
  return bad('loras must be an array');
}
for (const lora of params.loras) {
  if (typeof lora?.name !== 'string' || lora.name.length === 0) {
    return bad('each lora must have a non-empty name');
  }
  if (typeof lora.weight !== 'number' || !Number.isFinite(lora.weight)) {
    return bad('each lora must have a numeric weight');
  }
}
if (typeof params.positivePrompt !== 'string') return bad('positivePrompt must be a string');
if (typeof params.negativePrompt !== 'string') return bad('negativePrompt must be a string');
if (!Number.isInteger(params.width) || params.width < 64 || params.width > 4096) {
  return bad('width must be an integer between 64 and 4096');
}
if (!Number.isInteger(params.height) || params.height < 64 || params.height > 4096) {
  return bad('height must be an integer between 64 and 4096');
}
if (!Number.isInteger(params.steps) || params.steps < 1 || params.steps > 200) {
  return bad('steps must be an integer between 1 and 200');
}
if (typeof params.cfg !== 'number' || !Number.isFinite(params.cfg) || params.cfg < 0 || params.cfg > 30) {
  return bad('cfg must be a number between 0 and 30');
}
if (typeof params.seed !== 'number' || !Number.isInteger(params.seed)) {
  return bad('seed must be an integer (use -1 for random)');
}
if (typeof params.sampler !== 'string' || params.sampler.length === 0) {
  return bad('sampler must be a non-empty string');
}
if (typeof params.scheduler !== 'string' || params.scheduler.length === 0) {
  return bad('scheduler must be a non-empty string');
}
if (!Number.isInteger(params.batchSize) || params.batchSize < 1 || params.batchSize > 8) {
  return bad('batchSize must be an integer between 1 and 8');
}
```

Don't validate `sampler`/`scheduler` against the SAMPLERS/SCHEDULERS constants in `src/types/index.ts` — ComfyUI may have additional samplers from custom nodes that the constant doesn't list, and rejecting them at the API boundary would block valid workflows. Just check it's a non-empty string.

Don't validate `highResFix` / `baseImage` / `denoise` here either — `highResFix` is optional boolean (any truthy value works), `baseImage` and `denoise` are handled by the existing img2img code paths which tolerate missing values.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "?? '<gpu-vm-ip>'" src/` returns nothing.
- No hardcoded username fallbacks remain in SSH-using source files.
- The disk-avoidance assertion in `/api/generate` still runs after the new validation block (validation order: JSON parse → param shape checks → mask/refs checks → assemble prompts → buildWorkflow → forbidden-class scan → POST to ComfyUI).
- No new npm dependencies were added (`git diff package.json package-lock.json` should be empty).

Manual smoke test (deferred to user):
1. Hit `/api/generate` with a deliberately-bad body (e.g., `width: 'foo'`) and confirm a 400 with a clear message.
2. Generate an image normally — happy path still works end to end.
3. With `A100_VM_USER` temporarily commented out in `.env` and pm2 restarted, attempt to delete a model → 500 with the expected error message. Restore `.env` after.

---

## Out of scope

- Don't add zod or any other validation library. Inline checks only.
- Don't change the validation of `mask` or `referenceImages` — those are already correct.
- Don't validate `sampler`/`scheduler` against the SAMPLERS/SCHEDULERS constants. ComfyUI custom nodes can extend these.
- Don't change `IMAGE_OUTPUT_DIR` or `A100_SSH_KEY_PATH` handling — they already fail closed correctly.
- Don't touch `civitaiIngest.ts`'s `CIVITAI_TOKEN ?? ''` — that one is already correctly checked at the start of `ingestModel`.
- This is NOT the same as the deferred model-dropdown loading bug. Don't touch `/api/models/route.ts` or `getNodeInputList()`.

---

## Documentation

No CLAUDE.md changes needed.

When done, push and create the PR via `gh pr create` per AGENTS.md.
