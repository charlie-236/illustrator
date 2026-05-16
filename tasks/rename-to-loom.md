# Batch — Rename app to Loom + install new logo

The app gets a new name and identity. "Illustrator" undersold the actual surface — the project is now a multi-modal creative workspace with images, video, storyboards, and incoming long-form prose. New name: **Loom** (weaving threads → narrative threads).

Six logo asset files have been provided alongside this prompt. These logos are located at src/logos/ 

- `loom-logo.svg` — master 200×200 logo, used at large sizes
- `icon.svg` — simplified 32×32 logo, used as the favicon source
- `favicon-16x16.png` — rasterized favicon, 16px
- `favicon-32x32.png` — rasterized favicon, 32px
- `apple-touch-icon.png` — 180×180 raster for iOS / Android home-screen install
- `icon-192.png`, `icon-512.png` — Android home-screen / PWA manifest sizes
- `LoomLogo.tsx` — React component for the inline header mark

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

The user has placed the asset files in the repo root or `/mnt/user-data/uploads/`. Move them to their final locations per the instructions below; if they're missing, halt and surface the issue.

---

## Required changes

### Part 1 — Place the favicon assets in `src/app/`

Next.js 13+ App Router automatically serves favicon assets placed in `src/app/`. Move files as follows:

| Source filename | Destination path |
|---|---|
| `icon.svg` | `src/app/icon.svg` |
| `favicon-16x16.png` | `src/app/favicon-16x16.png` |
| `favicon-32x32.png` | `src/app/favicon-32x32.png` |
| `apple-touch-icon.png` | `src/app/apple-icon.png` |
| `icon-192.png` | `src/app/icon-192.png` |
| `icon-512.png` | `src/app/icon-512.png` |

The Next.js convention is `src/app/icon.<ext>` and `src/app/apple-icon.<ext>` — that's why `apple-touch-icon.png` becomes `apple-icon.png` at the destination.

If a `src/app/favicon.ico` exists today (legacy), delete it. Next.js prefers the SVG/PNG icons when both exist, but a stale `.ico` can confuse some browsers' caches.

### Part 2 — Place the master logo in `public/` for marketing/about uses

`loom-logo.svg` → `public/loom-logo.svg`

This is the canonical large-format mark for any future use (about page, project README screenshots, etc.). Not load-bearing in this batch; just put it where it can be referenced by URL if needed.

### Part 3 — Place the React component

`LoomLogo.tsx` → `src/components/LoomLogo.tsx`

Standard component path. Matches the existing convention in the repo.

### Part 4 — Update the app metadata in `src/app/layout.tsx`

Find the existing `metadata` export. Replace the `title` and any related fields with Loom-flavored values:

```ts
export const metadata: Metadata = {
  title: 'Loom',
  description: 'Multi-modal creative workspace for stories.',
  // If there's an icons block, simplify or remove it — Next.js auto-generates
  // <link> tags for icons placed at the conventional paths in src/app/.
};
```

If the existing metadata had explicit `icons: { ... }` entries, remove them in favor of the auto-discovery from Part 1. (If Next.js's auto-discovery doesn't produce the expected `<link>` tags after build, fall back to explicit `icons` declarations referencing the file paths.)

### Part 5 — Replace the in-app header text and sparkle icon

Find the header rendering — probably in `src/components/AppShell.tsx`, `src/components/Header.tsx`, or directly in `src/app/page.tsx` or `src/app/layout.tsx`. Look for the existing "Illustrator" text and the ✨ sparkle prefix (visible top-left in the screenshot).

Replace with:

```tsx
import LoomLogo from '@/components/LoomLogo';

// In the header JSX:
<div className="flex items-center gap-2">
  <LoomLogo size={28} />
  <span className="text-xl font-medium text-violet-400">Loom</span>
</div>
```

Adjust the size and styling to match what's already there visually — the sparkle ✨ today is roughly 20-24px and pairs with the word "Illustrator" in violet. Match that scale. The wordmark color should be `text-violet-400` to match the existing accent.

### Part 6 — Sweep "Illustrator" string references

`grep -rn "Illustrator" src/` will find user-visible string occurrences. Rename to "Loom" wherever the string is part of the user-facing UI:

- The header (Part 5)
- The browser tab / `metadata.title` (Part 4)
- Any "Welcome to Illustrator" / about-text strings
- Any error messages or toasts containing "Illustrator"
- The HTML `<title>` if hardcoded anywhere (most should come from metadata; check)

DO NOT rename:
- The package name in `package.json` (`"name": "illustrator"`) — keeping the npm-package name avoids npm-related side effects
- The PM2 process name (`illustrator` in `ecosystem.config.js`) — operator muscle memory, no benefit to renaming
- Any database / Prisma references (table names, schema names) — not user-visible
- The repo name on GitHub — out of scope for this batch
- Comments / internal documentation referencing the project as "illustrator" or "the illustrator project"
- The `BACKLOG.md`, `ARCHITECT.md`, etc. role files — internal tooling, not user-visible

The principle: rename what users see; leave what only operators see.

### Part 7 — Update CLAUDE.md

Find references to the app name. Update user-facing copy ("Illustrator" → "Loom"), but leave references that describe the codebase's identity ("the illustrator codebase", file paths like `/home/<user>/illustrator/`) alone.

The first-paragraph project description should now read something like:

> Loom is a tablet-first multi-modal creative workspace. Single-user, local-first. Generates images and video clips via ComfyUI on a remote GPU VM, plans projects via storyboards driven by a local LLM, and is being extended toward long-form prose.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `src/app/icon.svg`, `src/app/favicon-16x16.png`, `src/app/favicon-32x32.png`, `src/app/apple-icon.png`, `src/app/icon-192.png`, `src/app/icon-512.png` all exist.
- `src/components/LoomLogo.tsx` exists.
- `public/loom-logo.svg` exists.
- `src/app/layout.tsx`'s `metadata.title` is `'Loom'` (or contains it).
- The in-app header no longer shows ✨ sparkle + "Illustrator"; it shows the Loom mark + "Loom" wordmark.
- `grep -rn "Illustrator" src/` returns matches only in code comments and internal references — no user-visible strings.
- `package.json` `"name"` field is unchanged (still `illustrator`).
- `ecosystem.config.js` PM2 process name is unchanged.
- After running `npm run build && pm2 restart illustrator`, the browser tab shows "Loom" with the new favicon, and the app header shows the new mark + wordmark.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. Hard-refresh the app (Ctrl+Shift+R or equivalent). Confirm the browser tab title is "Loom" and the favicon is the violet weave.
2. Confirm the app's top-left header shows the new mark + "Loom" wordmark, no ✨, no "Illustrator" text.
3. On the tablet's Chrome browser: tap "Add to Home Screen" (or equivalent). Confirm the saved icon is the new logo, not the stylized "I" the user disliked.
4. Open Studio. Generate an image. Confirm no regression — generation works as before; nothing in the rename path touched the workflow.
5. Disk-avoidance check: `ssh <gpu-vm> ls /models/ComfyUI/output/*.png` returns "no such file or directory" after generation.

---

## Out of scope

- Renaming the GitHub repo, npm package, PM2 process, or any operator-facing string.
- Renaming database tables, Prisma schema names, or environment variables.
- A "splash screen" / loading screen for the app.
- A redesigned light-mode variant — Loom is dark-only by design.
- A monochrome fallback variant of the logo. Use the violet version everywhere; if a one-color version is needed later, that's a follow-up.
- Changing the tab bar styling, the violet accent throughout the app, or any UI surface beyond the top-left header.
- Updating role files (ARCHITECT.md, DEBUGGER.md, QA.md, COWORK.md). These reference "illustrator" as the project's internal identifier.
- Updating commit messages or branch names.

---

## Documentation

CLAUDE.md updates per Part 7 above. No further documentation changes.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
