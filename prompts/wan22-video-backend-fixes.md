# Batch — PR #13 fixes (video backend)

QA found three blocking bugs in PR #13 (`wan22-video-backend`). PR is still open and not merged. Apply these fixes to the same branch and push — this is an amendment, not a follow-up PR.

---

## Fix 1: SSH cleanup on client abort

`removeJob(promptId)` in `comfyws.ts` is called when the SSE client disconnects (close tab, lose wifi, abort). Today it just clears the timeout and removes the job from the map. ComfyUI keeps running the workflow on the VM; SaveWEBM eventually flushes a webm file; nothing fetches or deletes it; the file orphans on the VM forever.

This is the exact disk-leak the SSH cleanup `finally` block was designed to prevent. It's correctly handled in `finalizeVideoJob`, `expireJob`, and the `execution_error` path — but not in `removeJob`.

In `comfyws.ts`'s `removeJob`:

```ts
removeJob(promptId: string) {
  const job = this.jobs.get(promptId);
  if (!job) return;
  if (job.timeoutId != null) clearTimeout(job.timeoutId);

  // If this is a video job that hasn't been finalized, the file may have been
  // (or be about to be) written to the VM. Fire-and-forget SSH cleanup; the
  // glob is idempotent and will no-op if no file exists yet.
  if (job.mediaType === 'video' && !job.finalized && job.generationId) {
    sshCleanupVideo(job.generationId).catch((err) => {
      console.error(`[comfyws] SSH cleanup failed for aborted job ${promptId}:`, err);
    });
  }

  this.jobs.delete(promptId);
}
```

Three things to check:

- The job object already tracks `mediaType` and `generationId` (set at registration time per the PR's existing structure). If the field name differs, match what's there.
- `finalized` is the flag `finalizeVideoJob` sets to indicate the file's already been fetched and the in-band SSH `rm` ran. If a job is finalized, no cleanup needed (the file is already gone). If the field isn't already there, add it: set `false` at registration, set `true` at the end of `finalizeVideoJob` after the SSH rm completes.
- `sshCleanupVideo` is the existing helper. Reuse it — don't duplicate the SSH logic.

Mirror the same logic in any other place jobs leave the map without going through finalize/expire/error — `grep -n "this.jobs.delete" src/lib/comfyws.ts` to confirm the only paths.

## Fix 2: Negative prompt default handling

PR currently has the route doing `negativePrompt: negativePrompt ?? ''`, then the builder writes whatever it got into node 7. When the caller omits the field, this overwrites the template's Chinese default with empty string — the exact thing the architect prompt explicitly said not to do.

Three changes:

**(a) Export the default from `wan22-workflow.ts`:**

```ts
export const WAN22_DEFAULT_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
```

Verify byte-for-byte against `prompts/wan22_t2v.json` node 7's `inputs.text` — copy from the JSON, don't retype. Both templates use the same string; one source of truth.

**(b) Resolve the default in the route, not the builder:**

In `src/app/api/generate-video/route.ts`, replace:

```ts
negativePrompt: negativePrompt ?? '',
```

with:

```ts
negativePrompt:
  negativePrompt && negativePrompt.trim().length > 0
    ? negativePrompt
    : WAN22_DEFAULT_NEGATIVE_PROMPT,
```

This way `videoParams.negativePrompt` is always a non-empty string by the time it reaches the builder, the DB persist call, anywhere else.

**(c) Builder writes unconditionally:**

In `wan22-workflow.ts`, the current shape is roughly:

```ts
if (params.negativePrompt !== undefined) {
  wf['7'].inputs.text = params.negativePrompt;
}
```

Replace with:

```ts
wf['7'].inputs.text = params.negativePrompt;
```

…and make `negativePrompt` non-optional in the `VideoParams` type. The route guarantees it's set, so the optionality is no longer load-bearing — and removing it makes the contract clear: the builder doesn't own the default, the route does.

DB persistence already reads `videoParams.negativePrompt` and writes it to `promptNeg`. With this fix that's the resolved string (caller-supplied or Chinese default). Remixability works.

## Fix 3: Fail-fast env-var check

`IMAGE_OUTPUT_DIR` is currently checked inside `finalizeVideoJob`, which runs after the 14-minute generation. Move the check to the top of the route's POST handler, before any work happens:

```ts
const outputDir = process.env.IMAGE_OUTPUT_DIR;
if (!outputDir) {
  return new Response(
    JSON.stringify({ error: 'IMAGE_OUTPUT_DIR is not configured' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
}
```

Then pass `outputDir` to `finalizeVideoJob` rather than re-reading the env there. Same pattern the SSH env vars already use in this PR — fail closed at entry, treat env reads as one-time route concerns.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "WAN22_DEFAULT_NEGATIVE_PROMPT" src/` shows the export in `wan22-workflow.ts` and the import in `generate-video/route.ts`. No other definitions of the string.
- `grep -n "negativePrompt ?? ''" src/` returns no matches.
- `grep -n "sshCleanupVideo" src/lib/comfyws.ts` shows calls in `finalizeVideoJob`, `expireJob`, `removeJob`, and the `execution_error` path. Four sites.
- Builder's `VideoParams` type has `negativePrompt: string` (not optional).

Manual smoke test (deferred to user — Charlie):

1. **Abort cleanup.** Start a video generation via curl. Kill the curl process within 30 seconds. Wait 5 minutes. Then:
   ```bash
   ssh a100-core 'ls /models/ComfyUI/output/video-* 2>/dev/null | wc -l'
   ```
   Expect: `0`. The orphaned generation got cleaned up either immediately by `removeJob`'s fire-and-forget, or by ComfyUI never finishing because the prompt was canceled, or by the eventual SaveWEBM landing into a glob that the deferred SSH `rm -f` already ran on. The exact path depends on ComfyUI's behavior post-disconnect, but the file should not be there.

   Note: ComfyUI may continue running the workflow even after the WS subscriber disconnects. If it does and SaveWEBM lands after `removeJob`'s cleanup ran, that file will orphan. If you observe this in the smoke test (the file IS there after 5 min), file a follow-up — the right fix is a second cleanup pass after the expected generation duration, but it's a separate batch.

2. **Default negative prompt persisted.** POST a video request omitting `negativePrompt`. Wait for completion. Inspect the DB row:
   ```sql
   SELECT promptNeg FROM Generation WHERE id = '<generationId>';
   ```
   Expect: the full Chinese default string, not empty.

3. **Override negative prompt persisted.** POST a video request with `negativePrompt: "blurry"`. Inspect the DB row. Expect: `"blurry"`, not the Chinese default.

4. **Fail-fast env check.** Temporarily unset `IMAGE_OUTPUT_DIR` (`unset IMAGE_OUTPUT_DIR && npm run dev` in a fresh shell). POST a video request. Expect: 500 returned within milliseconds, before any ComfyUI work happens. Restore the env var afterward.

5. **No regression.** Existing image generation still works. Generate one image via Studio.

---

## Out of scope

- Don't address QA Bug 1 (executed-before-flush ordering). Hypothetical, not observed in the wall-clock smoke test. If it ever manifests, the fix is a small retry on the `/view` fetch — separate batch.
- Don't address QA Bug 6 (filename collision). Two video generations within 1ms when each takes 14 minutes is structurally impossible.
- Don't refactor the job manager beyond adding `mediaType`/`generationId`/`finalized` fields if they're not already there.
- Don't change the validation rules, the workflow builder's parameter map, or the SSH cleanup glob pattern.
- Don't touch the image path.

---

## Documentation

If CLAUDE.md's video section mentions cleanup paths, update it to list four (`finalizeVideoJob`, `expireJob`, `execution_error`, `removeJob`). If it's silent on cleanup paths, leave it.

When done, push to the existing PR #13 branch. Comment on the PR summarizing the three fixes. No new PR.
