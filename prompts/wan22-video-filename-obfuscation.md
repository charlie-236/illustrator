# Batch — Obfuscate VM filename prefix for video generations

Per PR #13, video generations write a temporary file to the VM with `filename_prefix: video-${generationId}`. The user wants this prefix randomized so abandoned files (in the rare crash case before ram-sweeper picks them up) aren't discoverable by their relationship to the application.

This is a one-line conceptual change with three small touch points. Extension stays `.webm` — that's a generic format identifier, not application-specific.

---

## Required changes

### `src/lib/wan22-workflow.ts`

The builders (`buildT2VWorkflow` and `buildI2VWorkflow`) currently hardcode `filename_prefix: video-${generationId}` on node 47. Refactor to take it as a parameter:

```ts
type VideoParams = {
  generationId: string;
  filenamePrefix: string;   // NEW — what gets written to node 47
  prompt: string;
  // ...
};
```

In the builders, replace whatever currently sets node 47's prefix with `wf['47'].inputs.filename_prefix = params.filenamePrefix;`. Don't construct the prefix inside the builder — the route owns this concern.

`generationId` is still on the type because it's used elsewhere (DB row, possibly job registration). Don't remove it.

### `src/app/api/generate-video/route.ts`

Generate the random prefix at the top of the POST handler, after validation but before workflow build:

```ts
import { randomBytes } from 'crypto';
// ...
const filenamePrefix = randomBytes(8).toString('hex'); // 16 hex chars
```

8 random bytes = 16 hex characters, ~64 bits of entropy. Far more than enough to be unguessable; short enough to be readable in logs.

Pass it to the builder:

```ts
const workflow = mode === 't2v'
  ? buildT2VWorkflow({ generationId, filenamePrefix, ...videoParams })
  : buildI2VWorkflow({ generationId, filenamePrefix, ...videoParams, startImageB64 });
```

Store it on the job for the cleanup paths:

```ts
manager.registerJob(promptId, {
  generationId,
  filenamePrefix,    // NEW — cleanup uses this, not generationId
  mediaType: 'video',
  // ...
});
```

The cuid still goes into the job for DB-row correlation. `filenamePrefix` is the additional field for VM-side filename tracking.

### `src/lib/comfyws.ts`

Three places need updating: `sshCleanupVideo`, the four cleanup call sites, and the `Job` type.

**`sshCleanupVideo` signature.** Today it takes `generationId` and globs `/models/ComfyUI/output/video-${generationId}*`. Change it to take the prefix directly:

```ts
async function sshCleanupVideo(filenamePrefix: string): Promise<void> {
  // ...
  await ssh.execCommand(`rm -f /models/ComfyUI/output/${filenamePrefix}*`);
}
```

The glob still covers `_00001_.webm` (SaveWEBM's auto-suffix) and any partial files from a crashed run.

**Validate the prefix before interpolating.** Even though we generate it from `randomBytes` and it's hex-only, defense-in-depth: assert it matches `/^[a-f0-9]{16}$/` at the top of `sshCleanupVideo`. Throw if not. The `rm -f` would otherwise be a shell-injection vector if the prefix ever flowed in from an untrusted source — which it shouldn't, but the validation makes the contract explicit.

**Four cleanup call sites.** All four currently pass `job.generationId` to `sshCleanupVideo`. Switch to `job.filenamePrefix`:

- `finalizeVideoJob`
- `expireJob`
- `removeJob` (the abort-cleanup path added in the PR #13 fixes)
- The `execution_error` handler

**`Job` type.** Add `filenamePrefix: string` to the job-record type. If the type is currently a flat shape with optional fields per media type, add it as optional and validate at use; if it's a discriminated union, add it to the video variant only. Match existing conventions.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "video-\\\${generationId}\\|video-\\\${.*generationId" src/` returns no matches.
- `grep -n "filenamePrefix" src/` returns matches in `wan22-workflow.ts`, `generate-video/route.ts`, and `comfyws.ts`.
- `sshCleanupVideo` takes `filenamePrefix: string` (not `generationId`) and asserts it matches `/^[a-f0-9]{16}$/` before using it.
- All four cleanup call sites pass `job.filenamePrefix`.

Manual smoke test (deferred to user):

1. Generate a video. While it's running, on the VM:
   ```bash
   ssh a100-core 'ls /models/ComfyUI/output/'
   ```
   Expect: a file matching `[a-f0-9]{16}_00001_.webm`. No `video-...` prefix.

2. Wait for completion. Re-run the ls. Expect: no matching file (cleanup ran).

3. Start a video, kill the curl/client immediately. Wait long enough for SaveWEBM to land on the VM (~14 min). Re-run the ls. Expect: no matching file (the abort cleanup glob ran with the right prefix).

4. Verify the generation's DB row still has the correct `generationId` (cuid format, not hex). The two identifiers serve different purposes — DB correlation vs. VM filename — and shouldn't be conflated.

---

## Out of scope

- Don't change the `.webm` extension. The format identifier is generic; what we wanted to obscure was the relationship between the filename and the application, not the file format.
- Don't randomize the local-side filename. The local path mirrors the image path's convention — keep it readable in the gallery directory.
- Don't change the `Generation` DB row schema. `generationId` (cuid) is still the primary key.
- Don't touch the image path.

---

## Documentation

In CLAUDE.md's video section, find any mention of `video-${generationId}` or `video-*` glob and update to reflect the random hex prefix. State plainly: *"The VM filename prefix is a random 16-character hex string generated per request. The full filename including SaveWEBM's auto-suffix matches `[a-f0-9]{16}_00001_.webm`. The prefix is stored on the in-flight job record so all cleanup paths use the correct glob."*

When done, push and create the PR via `gh pr create` per AGENTS.md.
