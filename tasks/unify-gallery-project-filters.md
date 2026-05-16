# Batch — Unify gallery and project-detail filters to four-way

Gallery and Project Detail use different filters for the same underlying data. Gallery is three-way (`'all' | 'image' | 'video'`); stitched outputs collapse into "Videos" alongside raw clips. Project Detail is four-way (`'all' | 'images' | 'clips' | 'videos'`) where "Clips" = `mediaType === 'video' && !isStitched` and "Videos" = `mediaType === 'video' && isStitched`. Same data, two languages. Unify on the four-way taxonomy so users see consistent labels everywhere.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/app/api/gallery/route.ts` — accept `isStitched` query param

Currently the route parses `mediaType` and passes it through to `where.mediaType`. Add a parallel `isStitched` param:

```ts
const isStitchedParam = url.searchParams.get('isStitched');
let isStitchedFilter: boolean | undefined;
if (isStitchedParam === 'true') isStitchedFilter = true;
else if (isStitchedParam === 'false') isStitchedFilter = false;

const where = {
  ...(favoritesOnly ? { isFavorite: true } : {}),
  ...(cursor ? { createdAt: { lt: cursor } } : {}),
  ...(mediaTypeParam ? { mediaType: mediaTypeParam } : {}),
  ...(isStitchedFilter !== undefined ? { isStitched: isStitchedFilter } : {}),
};
```

Backwards-compatible: omitting `isStitched` returns the existing behavior. `GalleryPicker.tsx` (which uses `mediaType=image`) is unaffected.

### `src/components/Gallery.tsx` — widen state, four chips

Currently `MediaFilter = 'all' | 'image' | 'video'`. Widen to plural four-way to match ProjectDetail:

```ts
type MediaFilter = 'all' | 'images' | 'clips' | 'videos';
const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
```

The fetch URL construction maps each filter value to query params:

```ts
const params = new URLSearchParams();
if (cursor) params.set('cursor', cursor);
if (favoritesOnly) params.set('isFavorite', 'true');
if (mediaFilter === 'images') {
  params.set('mediaType', 'image');
} else if (mediaFilter === 'clips') {
  params.set('mediaType', 'video');
  params.set('isStitched', 'false');
} else if (mediaFilter === 'videos') {
  params.set('mediaType', 'video');
  params.set('isStitched', 'true');
}
// 'all' → no params
```

Render all four chips unconditionally. Don't port ProjectDetail's hide-when-empty chip logic — Gallery is paginated and can't cheaply know totals; tapping an empty filter just shows the existing "no items" empty state.

Chip labels: "All", "Images", "Clips", "Videos". Match the existing pill styling (`min-h-12 px-4`, capitalized) for tablet-friendly touch targets.

The `loadMore` reset effect (which re-runs when `mediaFilter` changes) keeps its existing behavior — clearing the items list and refetching from cursor null.

### `src/components/ProjectDetail.tsx` — verify state shape exactly matches

ProjectDetail already uses `'all' | 'images' | 'clips' | 'videos'`. No state changes expected. Verify the union literal exactly matches Gallery's after the widening — both should use the exact same string keys.

The chip-conditional rendering (`hasImages`, `hasVideoClips`, `hasStitchedExports` gating which chips appear) stays in ProjectDetail. ProjectDetail has the full clip list in memory and can cheaply hide empty chips; that's a fair UX optimization specific to bounded project content. Don't change it.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "MediaFilter" src/components/Gallery.tsx` shows the union as `'all' | 'images' | 'clips' | 'videos'` (plural, four entries).
- `grep -n "isStitched" src/app/api/gallery/route.ts` shows the new param parsing and where-clause integration.
- `grep -n "mediaType=image" src/components/GalleryPicker.tsx` still returns the existing call (unchanged — backwards compat verified).
- Tapping each filter chip in Gallery returns a correctly filtered set:
  - Images → image rows only
  - Clips → video rows where `isStitched: false`
  - Videos → video rows where `isStitched: true`
  - All → everything
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Open Gallery. Confirm all four chips visible: All / Images / Clips / Videos.
2. Tap each. Confirm visible items match the taxonomy (Images = .png; Clips = .webm raw; Videos = .mp4 stitched).
3. Combine with Favorites toggle. Confirm AND filtering still works (e.g. Clips + Favorites → favorited unstitched videos only).
4. Open a Project's detail view. Confirm chip labels match Gallery exactly. Tap "Clips" in both surfaces — same kind of items appear.
5. Open the GalleryPicker (i2v starting frame picker in Studio). Confirm it still loads images-only and renders unchanged.

---

## Out of scope

- Changing the GalleryPicker's filter (it's image-only by design — i2v starting frames must be images, never videos).
- Adding chip-conditional hiding to Gallery. Gallery's pagination doesn't cheaply support knowing totals; always showing all four chips is fine.
- Adding a counts endpoint or badge ("Images (47)").
- Changing the modal's previous/next navigation logic. The mixed-media navigation order is unchanged.
- Renaming `mediaType` on the DB row or in `GenerationRecord`. The server-side model stays as is; only the client filter taxonomy widens.
- Changing how stitched outputs render in tiles vs raw clips. Existing tile rendering (badges, etc.) is unchanged.

---

## Documentation

In CLAUDE.md, find the line `**All/Images/Videos filter:** Pill toggle group...` in the Phase 1.3 section. Replace with:

> **All/Images/Clips/Videos filter:** Pill toggle group in the filter bar alongside the favorites toggle. Default: All. Four-way taxonomy matches the project detail view: "Clips" = unstitched videos, "Videos" = stitched outputs. Passes `mediaType=image` (Images), `mediaType=video&isStitched=false` (Clips), or `mediaType=video&isStitched=true` (Videos) to `GET /api/gallery`. Combines with favorites filter (AND).

Find the `GET /api/gallery` description. Update to mention the new `isStitched` query parameter:

> `GET /api/gallery` accepts optional `mediaType` (`image` or `video`), `isStitched` (`true` or `false`), and `isFavorite=true` query parameters. All filters AND together. Omitting any returns unfiltered for that dimension.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
