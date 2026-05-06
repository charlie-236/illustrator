# Batch — Phase 7b: Chat editing, regeneration, branching + tab reorder

Phase 7a shipped the foundation: data model, streaming, sampling, markdown rendering. Phase 7b adds the editing surface — the part of SillyTavern-style chat that makes it actually useful for iteration.

Three new capabilities:

1. **Regenerate an assistant message.** Each regeneration creates a new branch (sibling of the original). Old branch preserved.
2. **Edit any message.** Asymmetric semantics — user edits hard-truncate descendants (the directive changed; everything downstream is now invalid); assistant edits create a new branch (preserves old).
3. **Continue from cursor.** User edits an assistant message and taps "Save & continue" — the LLM resumes generating from the edited text via Aphrodite's assistant-prefill pattern.

Plus: **branch navigation UI** — `< 2/3 >` chevrons on messages with siblings, lets the user switch which branch is active. Active branch selection persists in DB on the Chat row.

Plus: **Projects becomes the first top-level tab.**

Re-read CLAUDE.md before starting, particularly the Phase 7a section. The schema fields `Message.parentMessageId` and `Message.branchIndex` already exist from 7a. This batch activates them.

---

## Critical: disk-avoidance and tablet UX

This batch doesn't touch the workflow build path, the WS finalize path, or any image/video generation logic. The forbidden-class-type guards are unaffected. Verify post-implementation with the standard greps.

Tablet UX rules apply throughout:
- Edit affordances ≥44px tap target (pencil icons, branch chevrons)
- Inline-edit textareas use the existing input-base styling, comfortable height
- Confirm dialogs use bottom-sheet pattern (mirror existing `StitchModal`)
- Regenerate / Continue buttons sit comfortably inside or beside message bubbles without crowding the prose

---

## Required changes

### Part 0 — Tab reorder: Projects first

In whatever component renders the top-level tab nav (likely `src/components/AppShell.tsx` or similar — search for the tab definitions Studio / Projects / Gallery / Chats / Models / Admin), reorder so Projects is first:

```
Projects · Studio · Gallery · Chats · Models · Admin
```

Single-line change. The default tab on app load also becomes Projects (instead of whatever was default before — likely Studio).

If the default-tab logic reads from sessionStorage to remember the user's last tab, leave that behavior alone — only change the fallback when no last-tab is stored.

### Part 1 — Schema: active branch tracking

`prisma/schema.prisma`:

```prisma
model Chat {
  // ... existing fields ...
  activeBranchesJson Json?    // Record<parentMessageId, activeBranchIndex>; null means all branches default to index 0
}
```

Apply via `npx prisma db push`. Existing chats backfill with null (treated as "all branches at index 0," which matches every existing 7a message).

The shape:
```ts
type ActiveBranches = Record<string, number>;
// Example: { "msg_abc123": 2, "msg_def456": 1 }
// Means: at the parent msg_abc123, the active branch is index 2.
//        at msg_def456, the active branch is index 1.
//        all other parents default to branch index 0.
```

This is server-side state. Persists across page reloads, devices, sessions.

### Part 2 — Types

`src/types/index.ts`:

```ts
export interface ChatRecord {
  // ... existing fields ...
  activeBranchesJson: Record<string, number> | null;
}

export interface MessageWithBranchInfo extends MessageRecord {
  // Computed at render time, not stored:
  branchCount: number;          // total siblings at this parent (1 if no branches)
  branchPosition: number;       // 1-indexed display ("2 of 3")
}
```

The `MessageWithBranchInfo` shape is computed in the client when rendering the active path through the message tree. It's not persisted.

### Part 3 — Active-path resolution helper

New file `src/lib/chatBranches.ts`:

```ts
import type { MessageRecord } from '@/types';

/**
 * Given all messages in a chat and the active-branches map, compute the linear
 * sequence of messages on the currently-active path through the message tree.
 *
 * Algorithm:
 *   1. Find the root message (parentMessageId === null, branchIndex === 0).
 *   2. From the root, walk forward. At each step, find children matching the
 *      current message id as parent. Among those children, pick the one whose
 *      branchIndex matches activeBranches[currentMessageId] (or branchIndex 0
 *      if no entry exists in the map).
 *   3. Continue until no more children. Return the path.
 */
export function resolveActivePath(
  messages: MessageRecord[],
  activeBranches: Record<string, number> | null,
): MessageRecord[] {
  const branches = activeBranches ?? {};
  const roots = messages.filter(
    (m) => m.parentMessageId === null && m.branchIndex === 0,
  );
  if (roots.length === 0) return [];

  // Take the first root (in 7a there's only one)
  const path: MessageRecord[] = [roots[0]];
  let current = roots[0];

  while (true) {
    const children = messages.filter((m) => m.parentMessageId === current.id);
    if (children.length === 0) break;

    const targetBranchIndex = branches[current.id] ?? 0;
    const next =
      children.find((c) => c.branchIndex === targetBranchIndex) ??
      children.sort((a, b) => a.branchIndex - b.branchIndex)[0];

    path.push(next);
    current = next;
  }

  return path;
}

/**
 * Given a message id and all messages, return the count of siblings at that
 * message's parent (including the message itself).
 */
export function getSiblingCount(
  messageId: string,
  messages: MessageRecord[],
): number {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return 1;
  return messages.filter((m) => m.parentMessageId === target.parentMessageId).length;
}

/**
 * Given a message id and all messages, return the 1-indexed branch position.
 * branchIndex 0 → position 1; branchIndex 1 → position 2; etc.
 */
export function getBranchPosition(
  messageId: string,
  messages: MessageRecord[],
): number {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return 1;
  return target.branchIndex + 1;
}

/**
 * Decorate a list of messages with branch info for rendering.
 */
export function decorateWithBranchInfo(
  messages: MessageRecord[],
): import('@/types').MessageWithBranchInfo[] {
  return messages.map((m) => ({
    ...m,
    branchCount: messages.filter((other) => other.parentMessageId === m.parentMessageId).length,
    branchPosition: m.branchIndex + 1,
  }));
}
```

The helpers are pure functions on the message array — they don't make API calls. Used by `ChatView.tsx` to compute the displayed message list.

### Part 4 — API: regenerate

`src/app/api/chats/[id]/regenerate/route.ts`:

```ts
// POST body: { messageId: string }
// where messageId is the assistant message to regenerate
```

Flow:

1. Validate input. Reject empty `messageId` with 400.
2. Fetch the chat with all messages. Confirm `messageId` exists, belongs to this chat, and `role === 'assistant'`.
3. Determine the new branch index: `max(branchIndex of all siblings) + 1`. (Siblings = messages with the same `parentMessageId`.)
4. Fetch the parent message — that's the user message we'll regenerate from.
5. Build the message context: walk the path from root to the parent (not including the message-being-regenerated). This is the conversation history the LLM sees.
6. Create the new assistant message row with `parentMessageId` = same parent, `branchIndex` = new index, `content` = empty initially.
7. Update `chat.activeBranchesJson` so this parent now points at the new branch index.
8. Stream the response from Aphrodite into the new message row, identical to `/api/chats/[id]/send`'s streaming pattern.

Response is SSE with the same event taxonomy as `send`:
- `assistant_message_started` with the new message id (no `user_message_saved` — there's no new user message)
- `token` repeated
- `done` or `error`

Critical: the message context built in step 5 is **all messages on the active path from root to the parent**, NOT including the message being regenerated or anything downstream. Use `resolveActivePath` and slice.

### Part 5 — API: edit user message (hard truncate)

`src/app/api/chats/[id]/messages/[msgId]/route.ts` — extend with PATCH for user messages.

PATCH body: `{ content: string }`

Flow:

1. Validate. Reject empty content with 400.
2. Fetch the chat with all messages. Confirm `msgId` exists, belongs to this chat, `role === 'user'`.
3. **Hard truncate everything after this message.** Compute "after" as: every descendant of the user message in the tree. A descendant is any message reachable by walking parent→child from `msgId`. Delete them all.
4. Update the user message's content. Bump `chat.updatedAt`.
5. Clear any `activeBranchesJson` entries for parents that no longer exist (cleanup).
6. Return the updated chat.

This is destructive. The agent confirms via dialog client-side (Part 9).

### Part 6 — API: edit assistant message (creates branch)

Same route, but for assistant messages, the semantics differ:

PATCH body: `{ content: string }` for plain edit; `{ content: string, andContinue: true }` for edit-and-continue.

For assistant messages, the request actually creates a new sibling branch rather than mutating in place. The route handles both shapes:

#### Plain edit (`andContinue: false` or absent)

1. Validate.
2. Fetch chat + messages.
3. Confirm message is assistant, exists, belongs to this chat.
4. Create a new sibling: same `parentMessageId`, `branchIndex` = max sibling index + 1, `content` = the edited content.
5. Update `chat.activeBranchesJson` to point this parent at the new branch.
6. Return the new message + updated chat.

JSON response (no streaming):
```ts
{ ok: true, newMessage: MessageRecord, chat: ChatRecord }
```

#### Edit and continue (`andContinue: true`)

Same flow as plain edit (steps 1-5), but then:

6. **Stream a continuation.** Build the message context: active path from root to the new branch's parent, plus the new branch as the last message (which is `role: 'assistant'`, content = edited prefix).
7. POST to Aphrodite with this message list and `stream: true`. The model continues from the edited prefix because the prefix is in the assistant role with no user message following.
8. Stream the continuation tokens to the client. Each token gets **appended** to the new branch's content (not replaced).
9. On done, update the new branch's content with `editedPrefix + continuation`. Save.

Response is SSE with the same shape as send/regenerate, but the `assistant_message_started` event includes the new branch's id (the one created in step 4).

The "continue" semantics are crucial: Aphrodite sees `[..., {role: 'user', content: '...'}, {role: 'assistant', content: 'The woman ran'}]` with `stream: true` and continues from "ran". This is the standard prefill pattern for OpenAI-compatible APIs that support it (which Aphrodite does).

If the model fights the prefill (some models reject continuation requests, generating a fresh response instead of continuing): that's a model behavior issue, not a code bug. Surface in PR notes if observed; not blocking.

### Part 7 — API: switch active branch

`src/app/api/chats/[id]/branch/route.ts`:

POST body: `{ parentMessageId: string, branchIndex: number }`

Flow:

1. Validate. Confirm at least one message exists with this `parentMessageId` and `branchIndex`.
2. Update `chat.activeBranchesJson` to set `[parentMessageId] = branchIndex`.
3. Return updated chat.

Trivial endpoint. Could be a PATCH on the chat directly with a partial `activeBranchesJson`, but a dedicated endpoint with validation is cleaner.

### Part 8 — Client: branch chevrons in message bubbles

`src/components/ChatMessage.tsx` — extend to render branch navigation when a message has siblings.

Inside each message bubble (user or assistant), when `branchCount > 1`:

```
┌──────────────────────────────────────────┐
│ [< 2/3 >]                                 │   ← only when branchCount > 1
│                                            │
│ <message content>                          │
│                                            │
│ [pencil] [regenerate] [continue]           │   ← action row, see Part 9
└──────────────────────────────────────────┘
```

Chevron interaction:
- Left chevron disabled when at branchIndex 0
- Right chevron disabled when at the highest sibling index
- Counter shows `<branchPosition>/<branchCount>`
- Tap a chevron: POST `/api/chats/[id]/branch` with the parent and target branchIndex; on success, refetch the chat and re-render

Active-path recomputation happens automatically via `resolveActivePath` after the chat refetches.

For tablet: chevrons + counter pill is a single tap target group, ~min-w-32 min-h-12.

The counter and chevrons should NOT render when `branchCount === 1` — we want clean message bubbles when there's no branching. Only show the affordance when branches actually exist.

### Part 9 — Client: action row on messages

`src/components/ChatMessage.tsx` — add an action row at the bottom of each message bubble. The actions vary by role.

#### User messages

- **Edit** (pencil icon) — opens inline-edit mode

Tapping Edit:
1. Replace rendered content with a textarea pre-filled with the message content.
2. Show Save / Cancel buttons.
3. On Save: open confirm dialog ("Edit this message? Everything after it will be removed.") If confirmed, PATCH the message with the new content. Hard truncate happens server-side.
4. On Cancel: revert.

Cancel during inline edit is non-destructive. Save IS destructive — hence the confirm.

#### Assistant messages

- **Edit** (pencil icon) — opens inline-edit mode
- **Regenerate** (refresh icon) — POST to regenerate route, streams a new branch
- **Continue** (arrow-right icon) — only visible during inline-edit mode; "Save & continue" mode

Edit on assistant messages:
1. Replace rendered content with a textarea pre-filled with the message content.
2. Show Save / Save & continue / Cancel buttons.
3. **Save**: PATCH with `{ content }`, no `andContinue`. New branch created with edited content. Page re-fetches.
4. **Save & continue**: PATCH with `{ content, andContinue: true }`. Streaming SSE handles the rest — the new branch's content becomes the edited prefix + the streamed continuation.
5. **Cancel**: revert, no changes.

Edit on assistant messages does NOT show a confirm dialog — it's not destructive (creates a branch).

Regenerate on assistant messages does NOT show a confirm dialog — also not destructive (creates a branch).

Confirm dialogs are reserved for user-message edits only, where the truncate IS destructive.

### Part 10 — Client: streaming flow updates

`src/components/ChatView.tsx` — extend the streaming logic to handle three event sources, all using the same SSE event vocabulary:

1. `/api/chats/[id]/send` (existing 7a — new user message + assistant response)
2. `/api/chats/[id]/regenerate` (new — regenerate existing assistant)
3. `/api/chats/[id]/messages/[msgId]` PATCH with `andContinue: true` (new — edit-and-continue)

All three return SSE with the same events. Refactor the streaming consumer into a shared helper:

```ts
async function consumeChatStream(
  responseBody: ReadableStream<Uint8Array>,
  callbacks: {
    onUserMessageSaved?: (id: string) => void;
    onAssistantMessageStarted: (id: string) => void;
    onToken: (text: string) => void;
    onDone: (id: string, finalContent: string, tokenCount: number) => void;
    onError: (message: string, reason: string) => void;
  },
): Promise<void>
```

This consolidates the parsing logic so the three flows share it. Inside the helper, use the same closure-pattern fix from the prior 7a bug fix — capture mutable locals (`assistantMsgId`, `accumulatedContent`) at the top of the function, not from React state.

After the stream finishes, ALL three flows trigger a chat refetch (`GET /api/chats/[id]`) to pick up server-side state changes (new branch indices, updated activeBranchesJson, message tree shape). This is simpler than incrementally maintaining client state for branch creation.

### Part 11 — Client: switching branches re-renders downstream

When the user taps a chevron to switch branches:

1. POST `/api/chats/[id]/branch`.
2. On success, refetch the chat.
3. `resolveActivePath` recomputes the displayed message list from the new `activeBranchesJson`.
4. Messages that were in the old path but not the new path disappear from view (still in DB; just not on the active path).
5. Scroll position: stay where the user is; don't auto-scroll on branch switch.

If the user switches a branch high in the conversation and the new branch has fewer descendants, the conversation gets shorter visibly. This is expected behavior.

### Part 12 — Edge cases

**Switching a branch invalidates downstream activeBranches entries.** When the user switches branches at parent X, the descendants change. Any `activeBranchesJson` entries for parents that no longer exist on the active path become stale. Don't proactively clean them — they're just dormant. If the user switches back to the old branch, those entries reactivate. (Cleanup happens only in user-edit hard-truncate, where the messages are actually deleted.)

**Regenerating a message in the middle of a conversation.** If the user regenerates an assistant message N that has descendants downstream, the descendants are still on the OLD branch of N. The new branch of N has no descendants yet (the user hasn't sent anything past it on the new branch). When the regeneration completes, `activeBranchesJson` points at the new branch — so the displayed conversation now ends at the new branch (no descendants). The old descendants are still in DB; user can switch back to see them.

**Edit-and-continue on a message with descendants.** Same as above. The new branch starts with the edited prefix + continuation; no descendants. The old branch and its descendants persist; user can switch to view them.

**Cancel mid-streaming during regenerate or continue.** Same flow as 7a's Stop button. Partial content persists in the new branch's content. The branch still exists — the user can navigate to it via chevrons, edit further, regenerate, etc.

**Empty branches.** If somehow a branch ends up with empty content (race condition, server crash mid-stream), it still appears in the chevron count but renders as a blank bubble. Acceptable; user can regenerate or edit.

**Continue-from-cursor on the FIRST assistant message.** Works the same way. The "edited prefix" is the user's edit; the prefill flows through Aphrodite normally.

### Part 13 — Documentation

CLAUDE.md updates per the standard pattern. Add a Phase 7b section under 7a:

> ## Phase 7b — Chat editing, regeneration, branching
>
> Activates the branching shape that was schemaed but dormant in 7a. Three new capabilities:
>
> - **Regenerate assistant messages.** Each regeneration creates a new sibling branch at the same parent. Old branch preserved; user navigates between via `< N/M >` chevrons in the message bubble.
> - **Edit any message.** Asymmetric semantics: user edits hard-truncate descendants (the directive changed; downstream is now stale); assistant edits create a new branch (preserves old).
> - **Continue from cursor.** User edits an assistant message and taps "Save & continue" — the LLM resumes generating from the edited text via Aphrodite's assistant-prefill pattern.
>
> **New schema field:** `Chat.activeBranchesJson` (`Record<parentMessageId, branchIndex>`). Server-authoritative active-path tracking. Persists across reloads.
>
> **New routes:**
> - `POST /api/chats/[id]/regenerate` — streams new sibling branch
> - `PATCH /api/chats/[id]/messages/[msgId]` — edit (user: hard truncate; assistant: new branch; with `andContinue: true` for assistant, streams continuation)
> - `POST /api/chats/[id]/branch` — switch active branch
>
> **Active-path resolution:** `src/lib/chatBranches.ts` provides `resolveActivePath(messages, activeBranches)` — pure function that walks the message tree and returns the displayed sequence.
>
> **Continue-from-cursor uses Aphrodite's assistant-prefill.** Sends the message list ending in `{role: 'assistant', content: '<edited>'}` with `stream: true`; Aphrodite resumes from the edit. Standard pattern; OpenAI doesn't support it but Aphrodite does.

Also add a Phase 7b section to the source layout documenting the new files.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `npx prisma db push` applies cleanly. `Chat.activeBranchesJson` column exists.
- Projects is the first top-level tab in the nav.
- Default tab on app load (when no sessionStorage entry exists) is Projects.
- New routes exist and respond:
  - `POST /api/chats/[id]/regenerate` (streaming SSE)
  - `PATCH /api/chats/[id]/messages/[msgId]` (JSON for plain edit, SSE for andContinue)
  - `POST /api/chats/[id]/branch`
- New helpers exist: `src/lib/chatBranches.ts`
- ChatMessage renders branch chevrons when `branchCount > 1`, hidden when `=== 1`.
- ChatMessage renders edit/regenerate/continue actions appropriately by role.
- User-edit confirms via dialog before destructive truncate.
- Assistant-edit and Regenerate do NOT show confirm dialogs.
- Continue-from-cursor flows: edit, then "Save & continue", then streamed continuation appends to the new branch.
- Switching branches refetches the chat; displayed messages update; scroll position maintained.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet):

1. **Tab order.** Refresh app. Confirm Projects is leftmost tab. Confirm app loads on Projects by default (when sessionStorage has no last-tab entry).
2. **Schema migration.** `npx prisma db push`. Confirm `activeBranchesJson` column on Chat. Existing chats backfill with null.
3. **Regenerate happy path.** In a chat with 2-3 turns, tap Regenerate on the last assistant message. Streaming starts; new branch creates. After done, the message bubble shows `< 2/2 >` chevrons. Tap left chevron — original response returns. Tap right — new response returns.
4. **Regenerate mid-conversation.** Send 3-4 turns. Tap Regenerate on assistant message #2. Streaming starts; new branch creates. After done, the conversation visibly truncates to end at the new branch (descendants of old branch #2 are no longer on active path). Tap left chevron at message #2 — old branch returns, full conversation reappears.
5. **Edit user message.** Send a directive. After response, tap Edit on the user message. Confirm dialog appears. Cancel. Modal closes; nothing changed. Tap Edit again, confirm. Edit textarea appears. Modify directive, Save. Confirm dialog. Save again. Conversation truncates after the user message; assistant response is gone. Send a new directive — new response.
6. **Edit assistant message — plain.** Tap Edit on an assistant message. Edit the content. Tap Save (not Continue). New branch creates. Chevrons appear (`< 2/2 >`). Tap left — original returns.
7. **Edit assistant message — continue.** Tap Edit. Modify the prose to end at a different point ("The woman ran" instead of "The woman walked into the room"). Tap Save & continue. Streaming starts; the LLM continues from "ran". The new branch's final content is "The woman ran" + continuation. Confirm chevrons show both branches.
8. **Branch persistence across reload.** After step 7, switch to the new branch. Reload page. Confirm the new branch is still active (didn't reset to branch 0).
9. **Branch persistence across device** (best-effort). If you have another browser tab open to the same chat, refresh it. Confirm the same active branch shows.
10. **Stop mid-regenerate.** Tap Regenerate; tap Stop while streaming. Partial content persists in the new branch. Chevrons show both branches; new one has partial content.
11. **Stop mid-continue.** Edit an assistant message; tap Save & continue; tap Stop while streaming. Partial continuation persists. The new branch's content is "edited prefix" + "partial continuation".
12. **Cancel inline edit.** Tap Edit on any message. Modify text. Tap Cancel. Confirm reverts to original; no change.
13. **Multiple regenerations.** Regenerate the same assistant message 3 times. Chevrons show `< 1/4 >` initially (after first regen made branch 2; second regen made branch 3; third made branch 4). Navigate through all 4 branches. Confirm each is a different response.
14. **Edit then regenerate.** Edit an assistant message, save (creates branch 2). Now tap Regenerate. Confirm regenerate creates branch 3 (sibling of original AND of edit). Chevrons cycle through 3 branches.
15. **Empty branch (force partial).** Stop mid-stream very early (within first token or two). Confirm the resulting branch has minimal content but doesn't crash the renderer.
16. **Send after switching branch.** Switch to an old branch high in the conversation. Send a new directive. The new directive becomes a child of the current end-of-active-path. Confirm new turn shows correctly. Then switch the high branch back — the new directive is no longer on active path (it's a descendant of a different branch now). Confirm UI reflects this.
17. **Disk-avoidance regression.** Generate an image and a video in Studio. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- **Branch labeling / naming.** Branches are identified by index (`< 2/3 >`); no user-supplied names.
- **Visual diff between branches.** No side-by-side comparison; user navigates with chevrons.
- **Bulk operations** (delete all old branches, prune the tree, etc.). Branches stay in DB indefinitely.
- **Active-branch indicator on the chat list.** The Chats tab list doesn't show which branch is active per chat.
- **Branching at non-leaf positions** beyond what regenerate / edit naturally produce. The user can't manually fork a chat at an arbitrary point.
- **Forking a chat into a new chat.** Out of scope.
- **Continue-from-cursor on user messages.** Doesn't make semantic sense.
- **Continue-from-cursor without an edit.** "Continue from end" would be a separate verb (just regenerating in continue mode); not in scope. If users want this, they edit nothing and tap Save & continue — the prefill is the full message content, and Aphrodite continues from there. May or may not work reliably depending on model. Acceptable as emergent behavior.
- **Visual indication of which branch was just edited.** No "★" on recently-edited branches.
- **Undo for edits.** The previous branch IS the undo (just navigate back). No separate undo stack.
- **Keyboard shortcuts** for branch navigation, edit, regenerate. Tap-only.
- **Edit history within a branch.** Editing a message creates a new branch — there's no in-branch edit log.
- **Server-side rate limiting** on regenerate / edit / branch endpoints. Single-user app; trust the user.

---

## Documentation

CLAUDE.md updates per Part 13. No further docs.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
