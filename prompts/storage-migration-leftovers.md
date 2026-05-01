# Batch — Clean up leftovers from image-storage migration

Two small cleanups left over from Batch P (image storage relocation).

1. `public/cleanup.sh` is a stale shell script that `srm -rf`'s `~/illustrator/public/generations`. Images no longer live there — they live under `IMAGE_OUTPUT_DIR`. The script is a no-op at best, misleading at worst. Worse, anything in `public/` is web-accessible: `https://mint-pc:3001/cleanup.sh` returns its contents, leaking VM/path details.
2. `src/app/api/models/[id]/route.ts` ends with three `revalidatePath(...)` calls that have no effect on client-side fetches with `cache: 'no-store'`. CLAUDE.md already acknowledges this. Dead code, should be removed.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Task 1 — Delete `public/cleanup.sh`

Just delete the file. Do not replace it with a rewritten version targeting `IMAGE_OUTPUT_DIR` — the user can write a one-shot `rm -rf "$IMAGE_OUTPUT_DIR"/*.png` if they want to wipe images, no need for a checked-in script.

```bash
git rm public/cleanup.sh
```

If `public/cleanup.sh` is referenced anywhere else in the repo (search with `grep -rn cleanup.sh`), remove those references too. Most likely there are none.

## Task 2 — Remove dead `revalidatePath` calls

In `src/app/api/models/[id]/route.ts`, the DELETE handler ends with:

```ts
revalidatePath('/api/models');
revalidatePath('/api/checkpoint-config');
revalidatePath('/api/lora-config');
```

…followed by `return NextResponse.json({ ok: true });`. Delete those three lines. Also remove the `import { revalidatePath } from 'next/cache';` at the top of the file — it's now unused.

The frontend already handles refresh manually: `ModelConfig.tsx` calls `refreshModelLists()` after a successful delete, and the explicit Refresh button in `ModelSelect.tsx`'s picker sheet covers the user-initiated refresh case. CLAUDE.md documents this design decision.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `public/cleanup.sh` no longer exists.
- `grep -rn revalidatePath src/app/api/models/\[id\]/route.ts` returns nothing.
- `grep -rn "next/cache" src/app/api/models/\[id\]/route.ts` returns nothing.

Manual smoke test (deferred to user):
1. After deploy, delete a model from Models tab. Confirm the row is removed from the picker (handled by the existing client-side refresh, no regression).
2. Hit `https://mint-pc:3001/cleanup.sh` from a browser → 404 (file gone).

---

## Out of scope

- Don't rewrite `cleanup.sh` to target `IMAGE_OUTPUT_DIR`. Just delete it.
- Don't touch the manual cleanup of `~/illustrator/public/generations/` on the host filesystem — that's the user's call to `rm -rf` (or leave it). It's already in `.gitignore` and not used by the app.
- Don't touch `revalidatePath` calls in any other route — only `/api/models/[id]/route.ts` is the target.

---

## Documentation

No CLAUDE.md changes needed.

When done, push and create the PR via `gh pr create` per AGENTS.md.
