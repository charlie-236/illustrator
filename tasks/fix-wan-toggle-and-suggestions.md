# Quick fix — Move WAN high/low to Models tab + diagnose disappearing suggestions

Two issues in one batch since both are small and isolated.

1. **WAN high/low toggles in wrong place.** Currently editable in Studio's `VideoLoraStack.tsx` (per-LoRA-row checkboxes). Should be editable in the Models tab's LoRA editor (`ModelConfig.tsx`) — that's where you configure the LoRA itself. Studio should display the configured scope as a read-only indicator so the user can SEE what's selected without having to remember.

2. **Suggested next prompts disappear.** Pills flash for a few seconds then disappear. Likely a state-management race between the post-stream `loadChat()` and the suggestions request, OR `decorateWithBranchInfo` stripping the `suggestionsJson` field on its rebuild pass.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Issue 1 — Move WAN high/low to ModelConfig, make Studio read-only

### Part 1A — Add toggles to ModelConfig.tsx (Models tab LoRA editor)

The current LoRA editor in `ModelConfig.tsx` has fields: File, Friendly Name, Trigger Words, Base Model, Category, Description. After the Base Model field, add an "Expert scope" section that ONLY appears when `loraForm.baseModel === 'Wan 2.2'`:

```tsx
{loraForm.baseModel === 'Wan 2.2' && (
  <div>
    <label className="label">Expert scope</label>
    <p className="text-xs text-zinc-400 mb-1.5">
      Wan 2.2 has separate high-noise and low-noise transformers. Most paired
      LoRAs target one specifically. Auto-detected from filename at ingest;
      override here if the detection was wrong.
    </p>
    <div className="flex items-center gap-4">
      <label className="flex items-center gap-2 min-h-12 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={loraForm.appliesToHigh ?? true}
          onChange={(e) => loraField('appliesToHigh', e.target.checked)}
          className="w-5 h-5 accent-violet-500"
        />
        <span className="text-sm text-zinc-300">High noise transformer</span>
      </label>
      <label className="flex items-center gap-2 min-h-12 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={loraForm.appliesToLow ?? true}
          onChange={(e) => loraField('appliesToLow', e.target.checked)}
          className="w-5 h-5 accent-violet-500"
        />
        <span className="text-sm text-zinc-300">Low noise transformer</span>
      </label>
    </div>
  </div>
)}
```

Verify the `loraForm` shape includes `appliesToHigh` and `appliesToLow` (booleans). If not, extend the form initialization to read them from the LoraConfig record:

```ts
// Wherever loraForm is initialized when a LoRA is selected for editing:
setLoraForm({
  friendlyName: lora.friendlyName,
  triggerWords: lora.triggerWords ?? '',
  baseModel: lora.baseModel ?? '',
  category: lora.category ?? '',
  description: lora.description ?? '',
  appliesToHigh: lora.appliesToHigh ?? true,   // NEW
  appliesToLow: lora.appliesToLow ?? true,     // NEW
});
```

The save handler (PATCH to `/api/loras/[name]` or wherever) must include these new fields in the request body. Verify the route accepts them; the schema columns already exist.

### Part 1B — Convert Studio's VideoLoraStack to read-only display

In `src/components/VideoLoraStack.tsx`, find the existing checkbox block (the `flex items-center gap-4 pt-0.5` with the two `<label>` tags containing checkboxes). Replace with a read-only badge display:

```tsx
{/* Expert-scope display — read-only. Edit in Models tab. */}
<div className="flex items-center gap-2 pt-1">
  <span className="text-xs text-zinc-500">Scope:</span>
  {entry.appliesToHigh && (
    <span className="text-xs px-2 py-0.5 rounded-full bg-violet-900/40 text-violet-300 border border-violet-700/50">
      High noise
    </span>
  )}
  {entry.appliesToLow && (
    <span className="text-xs px-2 py-0.5 rounded-full bg-violet-900/40 text-violet-300 border border-violet-700/50">
      Low noise
    </span>
  )}
  {!entry.appliesToHigh && !entry.appliesToLow && (
    <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700/50">
      Disabled (neither transformer)
    </span>
  )}
</div>
```

Remove the `onHighChange` and `onLowChange` props from the LoRA row component since they're no longer needed. Remove the corresponding `updateHigh` and `updateLow` callbacks in the parent `VideoLoraStack` component.

The `entry.appliesToHigh` / `entry.appliesToLow` values still come from the WanLoraEntry's persisted state (which initialized from `lists.loraAppliesToHigh[loraName]` when the LoRA was added). Display only — values can't be modified here.

When the user adds a Wan LoRA to the stack, the values flow as before:

```ts
function addLora() {
  // ... existing ...
  onChange([...loras, {
    loraName,
    weight: 1.0,
    appliesToHigh: lists.loraAppliesToHigh[loraName] ?? true,  // unchanged
    appliesToLow: lists.loraAppliesToLow[loraName] ?? true,    // unchanged
  }]);
}
```

If the user edits the LoRA in the Models tab while it's also in the Studio stack, the Studio display shows the OLD value (since `lists.loraAppliesToHigh` is a snapshot from when modelLists was loaded). This is fine — the next refresh of modelLists picks up the new value. Document: "edit in Models tab, then re-add to stack to pick up new scope."

Acceptance for Issue 1:
- Models tab LoRA editor shows two checkboxes for Wan 2.2 LoRAs (hidden for other base models).
- Editing the toggles and saving persists to DB.
- Studio's video LoRA stack shows scope as read-only badges, not interactive checkboxes.

---

## Issue 2 — Suggested next prompts disappear after appearing

### Diagnostic

The pills appear (so the API call succeeds and parsing works), then disappear. This means state was set correctly, then overwritten.

Three likely causes, in order of probability:

1. **`loadChat()` overwrites `allMessages`** when it fires after the suggestions request lands. The streaming flows all do `await loadChat()` in their `finally` blocks. If the suggestions request is fire-and-forget from the `done` handler, this sequence is possible:

   - `done` fires; `requestSuggestions` starts (async, fire-and-forget).
   - `finally` block runs, awaits `loadChat()`. Server returns messages; `Message.suggestionsJson` not yet populated (since suggestions endpoint just started).
   - `setAllMessages(d.chat.messages)` overwrites local state with server state (no suggestions yet).
   - 3 seconds later, suggestions request returns AND persists to DB.
   - Client-side `setAllMessages((prev) => prev.map(m => m.id === messageId ? { ...m, suggestionsJson: data.suggestions } : m))` updates the message. Pills appear.
   - **Then** something else triggers another `loadChat()` — branch switch, settings open, etc. Server returns updated messages WITH suggestions populated; pills should stay. UNLESS the rebuild path strips the field — see cause 2.

2. **`decorateWithBranchInfo` or `resolveActivePath` strips `suggestionsJson`.** The render path computes `activePath: MessageWithBranchInfo[]` from `allMessages` on every render. If either helper does a `.map()` that constructs a new object without explicitly preserving `suggestionsJson`, the rendered messages won't have it even if `allMessages` does.

3. **`MessageRecord` or `MessageWithBranchInfo` type definition doesn't include `suggestionsJson`.** If the type doesn't include the field, TypeScript-aware destructuring or rebuild logic might silently drop it.

### Fix

#### Step 1 — Confirm cause via console.log

Add three temporary logs in `ChatView.tsx`:

```ts
// In requestSuggestions (or wherever suggestions are received):
console.log('[suggestions] received for msg:', messageId, suggestions);

// After the setAllMessages that includes suggestions:
console.log('[suggestions] state after update:',
  allMessages.find((m) => m.id === messageId)?.suggestionsJson);

// In the render (just before rendering pills):
console.log('[suggestions] activePath last msg:',
  activePath[activePath.length - 1]?.id,
  activePath[activePath.length - 1]?.suggestionsJson);
```

Open the browser console during a chat send. Watch the sequence:
- Suggestions received → confirm the API returned a populated array
- State after update → confirm `allMessages` has `suggestionsJson` set
- ActivePath last msg → confirm the rendered message has `suggestionsJson`

If the third log shows `suggestionsJson` as undefined or null, the path-resolution helpers are stripping it. If the third log shows the field but pills still don't render, the issue is in the render condition.

If pills appear briefly then a console message shows `suggestionsJson` becoming undefined: another `setAllMessages` or `loadChat` overwrote it.

#### Step 2 — Fix path-resolution helpers (if cause 2)

In `src/lib/chatBranches.ts`, the `resolveActivePath` function returns `messages` directly (not rebuilt objects), so it should preserve all fields. Verify by reading.

`decorateWithBranchInfo` is suspect:

```ts
// CURRENT (might be stripping fields):
export function decorateWithBranchInfo(
  messages: MessageRecord[],
  allMessages: MessageRecord[],
): MessageWithBranchInfo[] {
  return messages.map((m) => ({
    branchCount: ...,
    branchPosition: ...,
    // If the spread comes AFTER these fields, only certain fields are preserved
  }));
}
```

Fix: ensure the spread `...m` is FIRST, with computed fields after:

```ts
export function decorateWithBranchInfo(
  messages: MessageRecord[],
  allMessages: MessageRecord[],
): MessageWithBranchInfo[] {
  return messages.map((m) => ({
    ...m,                                                                    // ALL fields preserved
    branchCount: allMessages.filter((other) => other.parentMessageId === m.parentMessageId).length,
    branchPosition: m.branchIndex + 1,
  }));
}
```

This is the load-bearing pattern: spread first, computed after. Any field on `MessageRecord` (including `suggestionsJson`) flows through.

#### Step 3 — Verify type definitions include suggestionsJson

In `src/types/index.ts`:

```ts
export interface MessageRecord {
  // ... existing fields ...
  suggestionsJson: Suggestion[] | null;
}

export interface MessageWithBranchInfo extends MessageRecord {
  branchCount: number;
  branchPosition: number;
}
```

The `extends MessageRecord` ensures `MessageWithBranchInfo` inherits all fields. If currently it duplicates fields manually (without `extends`), refactor to extend.

#### Step 4 — Make loadChat preserve client-side suggestions on re-fetch

Even with steps 1-3 fixed, there's a race: `loadChat()` runs in the `finally` block of every streaming flow. If suggestions arrive AFTER `loadChat()` has populated state from server (and server didn't yet have suggestions), the client-side merge updates messages. But if ANOTHER `loadChat()` fires later (for any reason), it might pull from server WHEN suggestions ARE persisted — so it should preserve them. So this is only a problem if there's a window where:
- Suggestions DB write is in progress (not committed)
- A loadChat reads in that window and doesn't see them

That's a tiny window but possible. Defense:

```ts
async function loadChat() {
  try {
    const res = await fetch(`/api/chats/${chatId}`);
    if (!res.ok) return;
    const d = (await res.json()) as { chat: ChatRecord };

    // Merge: prefer server state, but keep client-side suggestionsJson if server has none
    setAllMessages((prev) => {
      const prevById = new Map(prev.map((m) => [m.id, m]));
      return d.chat.messages.map((serverMsg) => {
        const localMsg = prevById.get(serverMsg.id);
        // If local has suggestions and server doesn't (yet), keep local
        if (localMsg?.suggestionsJson && !serverMsg.suggestionsJson) {
          return { ...serverMsg, suggestionsJson: localMsg.suggestionsJson };
        }
        return serverMsg;
      });
    });

    setChat(d.chat);
    setContextLimit(d.chat.contextLimit);
    setSettingsPresetId(d.chat.samplingPresetId);
    setSettingsOverrides(d.chat.samplingOverridesJson ?? {});
    setSettingsSystemPrompt(d.chat.systemPromptOverride ?? '');
    setSettingsContextLimit(d.chat.contextLimit);
  } catch {
    // Non-fatal
  }
}
```

The merge prefers server state for everything EXCEPT suggestionsJson, which is sticky from the client side until the server actually has it. Once both sides have it, server wins.

This is a defense-in-depth fix. The primary fix (step 2) should handle most cases; step 4 handles the edge case where suggestions land between server commit and client re-read.

#### Step 5 — Remove the diagnostic logs

After verifying the fix works, remove the console.logs from step 1.

### Acceptance for Issue 2

- After streaming completes, suggestion pills appear above the composer and STAY visible until:
  - The user starts typing in the composer (then pills hide), OR
  - The user sends a new message (then pills hide and new ones generate after next response), OR
  - The user switches to a different branch via chevrons (pills update to that branch's cached suggestions, or empty if not cached)
- Reloading the page on a chat with cached suggestions shows the pills immediately (no skeleton, since they're persisted in DB).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

---

## Combined acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "appliesToHigh\|appliesToLow" src/components/ModelConfig.tsx` shows the new editor section.
- `grep -n "Scope:" src/components/VideoLoraStack.tsx` shows the read-only badge display.
- `grep -n "checkbox" src/components/VideoLoraStack.tsx` returns nothing related to high/low (the interactive checkboxes are gone).
- `grep -n "...m," src/lib/chatBranches.ts` shows the spread-first pattern in `decorateWithBranchInfo`.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Edit LoRA scope in Models tab.** Open Models tab, select a Wan 2.2 LoRA. Confirm the "Expert scope" section appears with two checkboxes. Toggle both off. Save. Reload Models tab — toggles persist.
2. **Studio displays scope read-only.** Open Studio, switch to video mode. Add the LoRA you just edited to the stack. Confirm: scope display shows "Disabled (neither transformer)" badge. No interactive checkboxes.
3. **Studio scope updates on re-add.** With the LoRA in the Studio stack, go back to Models tab and toggle High noise back on. Save. Return to Studio. Remove the LoRA from the stack and re-add. Confirm scope shows "High noise" badge only.
4. **Non-Wan LoRA in Models tab.** Open Models tab, select an SDXL or Pony LoRA. Confirm the Expert scope section is hidden (only shows for Wan 2.2).
5. **Suggestions appear and stay.** New chat. Send a directive. Wait for response. Confirm three suggestion pills appear above composer. Wait 30 seconds without interacting. Confirm pills are still visible.
6. **Suggestions persist across branch switch.** In a chat with multiple branches that have cached suggestions, switch branches via chevrons. Confirm pills update to the new branch's cached suggestions.
7. **Suggestions persist across reload.** Reload the page on a chat with suggestions. Confirm pills appear immediately (from DB cache).
8. **Suggestions hide on type, reappear on clear.** With pills visible, type a single character in the composer. Pills hide. Clear the textarea. Pills reappear.
9. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Live sync of Studio's scope display when Models tab edits the LoRA (currently requires re-adding to stack). Could be future polish via a refresh button or modelLists invalidation on edit.
- A "regenerate suggestions" button if pills are unwanted or stale.
- Migrating existing Wan 2.2 LoRAs through a re-detect pass (existing values stay; user manually corrects in Models tab if needed).
- Animating pill appearance/disappearance.
- Keyboard shortcuts for selecting suggestions.

---

## Documentation

In CLAUDE.md, under the existing Phase 7 / Wan LoRA sections, add:

> **WAN expert scope is configured in the Models tab.** The LoRA editor's "Expert scope" section (visible only when baseModel is Wan 2.2) controls the appliesToHigh/appliesToLow flags. Studio's video LoRA stack displays the scope as read-only badges. Edit in Models tab, then re-add to the Studio stack to pick up changes.
>
> **Suggestions persist across re-fetches.** `loadChat()` merges client-side suggestionsJson with server state to handle the brief window where suggestions are written client-side but not yet readable from DB. `decorateWithBranchInfo` uses spread-first pattern to preserve all message fields (including suggestionsJson) through the path-resolution rebuild.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
