# Batch — Honest disk-avoidance grep guard (i2v template fix)

PR #19's i2v template `src/lib/wan22-templates/wan22_i2v.json` contains a `LoadImage` node (id 52) that `buildI2VWorkflow()` swaps for `ETN_LoadImageBase64` at runtime. This breaks the build-time grep guard:

```
grep -rn "class_type.*['\"]LoadImage['\"]" src/
```

…which AGENTS.md treats as a non-negotiable validation gate. The grep currently returns matches inside the template JSON, so we've already had to teach reviewers to ignore them — which means the next time *any* `LoadImage` appears in `src/`, the same "ignore the JSON template" instinct will let it slide. The guard's value is being a dumb tool that's right by construction; the moment it has exceptions, it stops being useful.

Fix: change `buildI2VWorkflow()` from swap-replace to **insert**. The template no longer contains node 52; the builder constructs the ETN_LoadImageBase64 node and adds it to the workflow object before submission.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/lib/wan22-templates/wan22_i2v.json`

Remove node `52` entirely. The link from node 52 to node 50 (WanImageToVideo's `start_image` input) becomes a **dangling reference** in the template — that's intentional. The builder is responsible for connecting it.

Specifically: the template's node 50 currently has `inputs.start_image: ['52', 0]`. Leave that link in place — the template would be invalid as-is for direct submission to ComfyUI, but it's never submitted as-is; the builder always runs first.

Add a comment-style note at the top of the file (or in a sibling README, since JSON doesn't support comments — pick the project convention) explaining that node 52 is intentionally absent and is added by `buildI2VWorkflow`.

### `src/lib/wan22-workflow.ts` — `buildI2VWorkflow`

Replace the swap-replace with an insert:

```ts
export function buildI2VWorkflow(params: VideoParams & { startImageB64: string }): ComfyWorkflow {
  const wf = structuredClone(I2V_TEMPLATE);

  // ...existing prompt/dimension/frames/seed/steps/cfg/filename_prefix mutations...

  // Insert the base64 image loader as node 52. The template intentionally
  // omits this node; the link from node 50 is dangling until we add it.
  wf['52'] = {
    inputs: { image: stripDataUriPrefix(params.startImageB64) },
    class_type: 'ETN_LoadImageBase64',
    _meta: { title: 'Load Image (Base64)' },
  };

  return wf;
}
```

The dangling-link → resolved-link transition happens by the simple act of node 52 existing once the insert runs. ComfyUI's prompt validation will then see a complete graph.

### Verify the t2v template doesn't have the same issue

`grep -n "LoadImage" src/lib/wan22-templates/wan22_t2v.json` should return nothing. T2V doesn't need an image loader. If it accidentally has one, strip it the same way.

### Tighten the grep guard (optional but recommended)

If the project already has a script or pre-commit hook that runs the disk-avoidance grep, leave it alone — after this batch, it'll return clean.

If the only invocation is in AGENTS.md / CLAUDE.md as a manual review step, leave the documentation as-is. The guard's text is unchanged; only the code that was triggering it changes.

Don't add an exclude-directory flag. The whole point is keeping the guard dumb.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns **only** ETN_LoadImageBase64 / ETN_LoadMaskBase64 references — **no** matches inside `src/lib/wan22-templates/`.
- `grep -n "LoadImage" src/lib/wan22-templates/wan22_i2v.json` returns nothing.
- `grep -n "LoadImage" src/lib/wan22-templates/wan22_t2v.json` returns nothing.
- `buildI2VWorkflow` inserts node 52 (creates the key on the workflow object), rather than mutating an existing node 52.

Manual smoke test (deferred to user):

1. Generate an i2v video. Confirm it completes successfully — the dangling link in the template gets resolved correctly by the builder, ComfyUI accepts the graph.
2. Generate a t2v video. Confirm no regression.
3. Confirm via `ssh a100-core 'ls /models/ComfyUI/output/'` that no files persist after generation completes (the existing cleanup paths still work).

---

## Out of scope

- Don't change the runtime `validateVideoWorkflow()` guard. It's a defense-in-depth backstop and stays as-is.
- Don't refactor the t2v template unless the verify step finds a `LoadImage` in it.
- Don't change `buildT2VWorkflow`.
- Don't add an exclude-directory flag to any grep script.
- Don't change AGENTS.md / CLAUDE.md beyond the small note below.
- Don't touch the other Phase 1 work (queue UX, gallery video).

---

## Documentation

In CLAUDE.md, find the "Video generation (Phase 1)" section. Add a paragraph:

> The i2v workflow builder constructs the `ETN_LoadImageBase64` node at runtime rather than reading it from the template. The template intentionally has a dangling link from `WanImageToVideo.start_image` that the builder resolves by inserting node 52. This keeps `LoadImage` out of the source tree entirely so the disk-avoidance grep guard remains dumb-and-correct.

When done, push and create the PR via `gh pr create` per AGENTS.md.
