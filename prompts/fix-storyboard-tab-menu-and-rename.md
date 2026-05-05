# Quick fix — Storyboard tab ⋮ menu + rename

Two small UX gaps in the multi-storyboard surface from Phase 5d:

1. The three-dot (⋮) overflow button on storyboard tabs is rendered but tapping it does nothing. The Phase 5d prompt asked for an overflow popover with Rename / Delete; the implementer wired the button into the DOM but skipped the popover. Delete-storyboard ended up living as a button at the bottom of the storyboard section instead — that path works, so deleting isn't blocked, but the ⋮ button is cosmetic dead weight.
2. There's currently no way to rename a storyboard. The Phase 5d prompt described rename via the same overflow menu; with the menu dead, rename was never reachable.

Fix: make the ⋮ menu actually open a popover with Rename and (already-existing) Delete actions. Wire Rename through to a small inline edit modal that PUTs the storyboard's new name. Don't remove the existing bottom-of-section Delete button — it works, the user has adapted to it, leaving it in place reduces churn. The ⋮ menu's Delete is a secondary surface for that action.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected — pure UI change.

---

## Investigation

Before changing code, find the existing structures:

1. **Read `src/components/ProjectDetail.tsx`** to find the storyboard tab strip rendering. Look for the JSX that renders one tab per storyboard with the ⋮ button.
2. **Read the ⋮ button's onClick handler.** Most likely scenarios:
   - It calls a setter like `setShowTabMenu(tabId)` but no popover JSX consumes that state.
   - It has an empty handler (`onClick={() => {}}`) or a TODO comment.
   - It calls a function that exists but is a stub.
3. **Identify the popover render site** — likely placed near the existing ProjectDetail-level overflow popover (the project-level Delete popover near the project header). If no popover exists for storyboard tabs, you'll add one.
4. **Confirm the existing storyboard rename API.** Check `src/app/api/storyboards/[id]/route.ts` (or wherever the storyboard PUT lives). The PUT validator from Phase 5d should already accept `name` as one of the storyboard fields. If it doesn't, the validator extends to allow updating just the name (1-100 chars after trim, required non-empty).
5. **Read the existing project name inline-edit pattern** in the same file (the project header has an inline rename via `editingName`/`saveName`). Match the same UX shape for storyboard rename — clicking Rename in the popover puts the tab into edit mode with the name as an editable input; Enter or blur saves; Escape cancels.

## Fix

### Part 1 — Make the ⋮ button open a popover

Mirror the project-level overflow popover pattern that already exists in `ProjectDetail.tsx`. State per active tab:

```ts
const [showTabMenu, setShowTabMenu] = useState<string | null>(null);  // storyboardId or null
const tabMenuRef = useRef<HTMLDivElement>(null);
```

The ⋮ button's onClick toggles the popover for that tab:

```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    setShowTabMenu((current) => current === storyboard.id ? null : storyboard.id);
  }}
  className="min-h-12 min-w-12 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
  aria-label="More options for this storyboard"
>
  {/* existing ⋮ SVG */}
</button>
```

Popover JSX, placed adjacent to the button:

```tsx
{showTabMenu === storyboard.id && (
  <div
    ref={tabMenuRef}
    className="absolute right-0 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl z-30 min-w-44 overflow-hidden"
  >
    <button
      onClick={() => { setShowTabMenu(null); startRenameStoryboard(storyboard); }}
      className="w-full min-h-12 px-4 flex items-center gap-3 text-sm font-medium text-zinc-200 hover:bg-zinc-800 transition-colors"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
      Rename
    </button>
    <button
      onClick={() => { setShowTabMenu(null); setShowStoryboardDeleteConfirm(true); }}
      className="w-full min-h-12 px-4 flex items-center gap-3 text-sm font-medium text-red-400 hover:bg-zinc-800 transition-colors"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      Delete
    </button>
  </div>
)}
```

The Delete entry routes to the same confirm dialog the bottom-of-section Delete button already uses — no new dialog needed, no new route call. This is the lazy-correct way to add it.

Click-outside-to-close: a `useEffect` listening for `mousedown` outside the ref clears `showTabMenu`. Mirror the existing project-level overflow popover's outside-click handler.

### Part 2 — Rename flow

`startRenameStoryboard(storyboard)` puts the tab into rename mode. Use a small piece of state:

```ts
const [renamingStoryboardId, setRenamingStoryboardId] = useState<string | null>(null);
const [renameValue, setRenameValue] = useState('');
const [renameSaving, setRenameSaving] = useState(false);
const renameInputRef = useRef<HTMLInputElement>(null);

function startRenameStoryboard(storyboard: Storyboard) {
  setRenamingStoryboardId(storyboard.id);
  setRenameValue(storyboard.name);
  setTimeout(() => renameInputRef.current?.select(), 10);
}
```

In the tab rendering, when the tab matches `renamingStoryboardId`, render an `<input>` instead of the name span:

```tsx
{renamingStoryboardId === storyboard.id ? (
  <input
    ref={renameInputRef}
    value={renameValue}
    onChange={(e) => setRenameValue(e.target.value)}
    onBlur={() => void saveRename(storyboard)}
    onKeyDown={(e) => {
      if (e.key === 'Enter') { e.preventDefault(); void saveRename(storyboard); }
      if (e.key === 'Escape') { setRenamingStoryboardId(null); }
    }}
    className="input-base text-sm flex-1"
    autoFocus
    disabled={renameSaving}
    maxLength={100}
  />
) : (
  /* existing tab name span */
)}
```

Save handler:

```ts
async function saveRename(storyboard: Storyboard) {
  const trimmed = renameValue.trim();
  if (trimmed === '' || trimmed === storyboard.name) {
    setRenamingStoryboardId(null);
    return;
  }
  setRenameSaving(true);
  try {
    const updated: Storyboard = { ...storyboard, name: trimmed };
    const res = await fetch(`/api/storyboards/${storyboard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard: updated }),
    });
    if (res.ok) {
      // Refresh project to pick up the renamed storyboard
      await load();
    }
  } finally {
    setRenameSaving(false);
    setRenamingStoryboardId(null);
  }
}
```

If the PUT route URL is different in the actual codebase, adjust accordingly. The agent reads the existing storyboard PUT call site (it already exists for canonical-clip changes) and matches it.

### Part 3 — Validate the PUT route accepts name updates

Open the storyboard PUT route. Verify its validator allows `name` to change. The 5d prompt's validator described "name 1-100 chars after trim" as a requirement; if the implementer skipped it, add it now.

If the route validates the entire storyboard object on each PUT (likely — that's what 5d called for), then sending the whole storyboard with just `name` changed should work without route changes. Verify by reading.

### Part 4 — No changes to the bottom-of-section Delete button

Leave the existing "Delete storyboard" button at the bottom alone. It works; the user has adapted to it. The ⋮ menu's Delete is purely additive — it gives users who instinctively look for context actions in the ⋮ menu a place to find it, without removing the affordance the user already knows works.

The two paths converge on the same confirm dialog (the existing `showStoryboardDeleteConfirm` state). One source of truth for the actual delete logic; two surfaces that trigger it.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The ⋮ button on a storyboard tab opens a popover with Rename and Delete options.
- Tapping Rename puts the tab into inline-edit mode with the current name selected.
- Pressing Enter or blurring saves the new name; PUT to the storyboard route succeeds.
- Pressing Escape cancels the rename without saving.
- Tapping Delete in the popover routes to the existing confirm dialog (same as the bottom Delete button).
- Tapping outside the popover closes it.
- Empty or whitespace-only names are rejected (rename returns to display state without saving).
- The bottom-of-section "Delete storyboard" button still works as before.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **⋮ opens menu.** Tap the ⋮ on the active storyboard's tab. Confirm a popover appears with Rename and Delete entries. Tapping outside closes it.
2. **Rename happy path.** Tap ⋮ → Rename. Confirm the tab name becomes an input with current value selected. Type a new name, press Enter. Confirm the tab updates with the new name; refreshing the page persists the new name.
3. **Rename via blur.** Same flow but tap elsewhere instead of pressing Enter. Confirm save fires.
4. **Rename cancel via Escape.** Start renaming. Type characters. Press Escape. Confirm name reverts to original; no PUT call fires.
5. **Rename empty.** Start renaming. Clear the input. Press Enter. Confirm rename cancels (name stays as original; no validation error needed since the empty case silently no-ops).
6. **Delete via ⋮.** Tap ⋮ → Delete. Confirm the existing confirm dialog appears. Confirm. Storyboard is deleted (same path as the bottom button).
7. **Delete via bottom button regression.** Tap the bottom "Delete storyboard" button. Confirm same dialog and behavior — no regression.
8. **Multiple storyboards.** Open ⋮ on tab A. Open ⋮ on tab B without closing first. Confirm only one popover is open at a time (B replaces A) — or that opening the second closes the first. Whichever pattern the existing project-level overflow uses; match it.

---

## Out of scope

- Drag-to-reorder storyboard tabs. Phase 5d's prompt mentioned it; if it doesn't exist or is also broken, that's a separate fix.
- Removing the bottom-of-section Delete button. Leave it in place.
- Adding any new fields to the storyboard schema.
- Changing the storyboard PUT route's overall shape.
- Renaming the popover entries' labels (Rename / Delete is fine).
- Adding keyboard shortcuts.
- Adding undo for renames or deletes.

---

## Documentation

In CLAUDE.md, find the Phase 5d section. Update the description of storyboard tab affordances to reflect the working state:

> Each storyboard tab has a ⋮ overflow menu with Rename and Delete entries. Rename puts the tab into inline-edit mode (Enter/blur save, Escape cancel). Delete routes to the same confirm dialog as the section-bottom "Delete storyboard" button — both surfaces converge on a single delete handler.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
