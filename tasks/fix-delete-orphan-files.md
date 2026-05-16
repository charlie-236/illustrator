# Batch — Fix delete-from-UI to actually remove image files from disk

When the user taps "delete" on a gallery thumbnail, the DB row is removed but the underlying PNG file is orphaned on disk. The cause is that `/api/generation/[id]/route.ts` still hardcodes the legacy `public/generations/` path that was used before Batch P (image storage relocation). Files now live under `IMAGE_OUTPUT_DIR`, so `unlink()` always hits ENOENT and the catch silently swallows it.

This is a regression introduced by Batch P. The fix is mechanical: rebuild the unlink path against `IMAGE_OUTPUT_DIR`, fail loudly if the env is missing, and distinguish ENOENT from real errors so future regressions are visible in the logs.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected by this change — we are deleting files on `mint-pc`, never on the A100 VM.

---

## Required changes

### `src/app/api/generation/[id]/route.ts` — DELETE handler only

Replace the hardcoded `public/generations/` path with `IMAGE_OUTPUT_DIR`. The handler should:

1. If `IMAGE_OUTPUT_DIR` is not set, return HTTP 500 with a clear error message — match the pattern in `src/app/api/images/[filename]/route.ts`. Do not fall back to any default.
2. Build the unlink path as `path.join(IMAGE_OUTPUT_DIR, filename)`.
3. Try the unlink. If it throws `ENOENT`, that's fine — file's already gone — keep going to the DB delete. For any other error (EACCES, EIO, etc.) log it via `console.error` but still proceed with the DB delete (the file is best-effort; the DB delete is the source of truth).
4. The existing filename-extraction logic (the `replace('/api/images/', '').replace('/generations/', '')` chain) is correct — both shapes produce a bare filename. Keep it. The path-traversal guard (`!filename.includes('..') && !filename.includes('/')`) is also correct.

Concrete shape:

```ts
const IMAGE_OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR;
if (!IMAGE_OUTPUT_DIR) {
  return NextResponse.json(
    { error: 'IMAGE_OUTPUT_DIR not configured' },
    { status: 500 },
  );
}
const filename = g.filePath
  .replace('/api/images/', '')
  .replace('/generations/', '');
if (filename && !filename.includes('..') && !filename.includes('/')) {
  const filePath = path.join(IMAGE_OUTPUT_DIR, filename);
  try {
    await unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[generation/delete] unlink failed for ${filePath}:`, err);
    }
  }
}
```

Then proceed with `prisma.generation.delete({ where: { id } })` as before. The DB delete must happen even if the unlink failed for a non-ENOENT reason — the DB is the source of truth, and stale files are recoverable separately.

The PATCH handler (favorite toggle) and GET handler need no changes.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "public.*generations" src/app/api/generation/\[id\]/route.ts` returns nothing — the legacy path is gone from this file.
- The DELETE handler reads `IMAGE_OUTPUT_DIR` from env and returns 500 if missing.
- Real unlink errors (anything other than ENOENT) are logged via `console.error`. ENOENT is silent.
- The DB record is deleted regardless of unlink outcome (best-effort file removal, authoritative DB delete).

Manual smoke test (deferred to user — requires Postgres + an image on disk):
1. Generate an image so a DB row + file exist. Note the filename.
2. Tap delete in the UI.
3. Verify the DB row is gone (`select * from "Generation" where id = '<id>'`).
4. Verify the file is gone from `IMAGE_OUTPUT_DIR` (`ls $IMAGE_OUTPUT_DIR`).
5. Tap delete again on a stale browser tab (record no longer in DB) → 404, no crash.
6. Manually `rm` an image file before deleting from UI → DB delete still succeeds, no error response.

---

## Out of scope

- No change to PATCH or GET in this route.
- No change to the model-delete endpoint at `/api/models/[id]` (that one uses SSH to delete files on the VM, different code path).
- No retroactive cleanup of already-orphaned files. The user can `find $IMAGE_OUTPUT_DIR -name '*.png'` and cross-reference with `select "filePath" from "Generation"` if they want a one-shot cleanup; that's not part of this batch.
- No change to `src/app/api/images/[filename]/route.ts` — it already does the right thing.

---

## Documentation

No CLAUDE.md changes needed — the architecture overview already describes the IMAGE_OUTPUT_DIR pattern. This change just makes one route consistent with the documented architecture.

When done, push and create the PR via `gh pr create` per AGENTS.md.
