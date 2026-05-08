# Quick fix — Suggestions persistence failure (silent prisma error)

Diagnosis: server logs show suggestions endpoint returned 200 in 10.9 seconds, but DB column `Message.suggestionsJson` is null. The most likely cause is a swallowed error in the `prisma.message.update` call:

```ts
// Current code in src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts
await prisma.message.update({
  where: { id: msgId },
  data: { suggestionsJson: suggestions as object[] },
}).catch(() => {});  // ← errors swallowed silently
```

If the cast `suggestions as object[]` produces something Prisma's Json column rejects, the update throws, is silently caught, and the route returns 200 with the suggestions in the HTTP response anyway. The client gets pills briefly (from local state), then any subsequent `loadChat()` returns `null` from DB and the pills disappear.

This batch surfaces the error so we can see what's actually failing, fixes the most likely cast issue, and adds defensive logging.

Re-read CLAUDE.md before starting. Disk-avoidance unaffected.

---

## Required changes

### Part 1 — Surface the swallowed error

In `src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts`, replace the persistence block:

```ts
// REPLACE THIS:
await prisma.message.update({
  where: { id: msgId },
  data: { suggestionsJson: suggestions as object[] },
}).catch(() => {});

// WITH THIS:
try {
  const updateResult = await prisma.message.update({
    where: { id: msgId },
    data: {
      suggestionsJson: suggestions as unknown as Prisma.InputJsonValue,
    },
  });
  console.log('[suggestions] persisted:', {
    msgId,
    suggestionCount: suggestions.length,
    persistedJson: updateResult.suggestionsJson,
  });
} catch (err) {
  console.error('[suggestions] PERSISTENCE FAILED:', {
    msgId,
    suggestionCount: suggestions.length,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    suggestionsShape: JSON.stringify(suggestions).slice(0, 500),
  });
  // Continue to return suggestions to client — the API call itself succeeded;
  // persistence is the problem.
}
```

Two key changes:
- **`as unknown as Prisma.InputJsonValue`** — the proper cast for Prisma JSON columns. The previous `as object[]` cast may not satisfy Prisma's stricter JSON typing.
- **Error visibility** — log the actual failure with full context. The user can copy-paste this from the dev terminal to see exactly what failed.

You may need to import `Prisma` at the top:

```ts
import { Prisma } from '@prisma/client';
```

### Part 2 — Verify the schema column type

Open `prisma/schema.prisma` and confirm the Message model has:

```prisma
model Message {
  // ... other fields ...
  suggestionsJson Json?
}
```

If it's typed differently (e.g., `Json` without nullable, or a custom type), that's the bug — Json column on Postgres is the right shape. Apply migration if changed.

### Part 3 — Confirm the parser actually returns valid Suggestion objects

The `Suggestion` type:

```ts
interface Suggestion {
  label: string;
  prompt: string;
}
```

A `Suggestion[]` should serialize cleanly to JSON. But if `parseSuggestions` is returning objects with extra fields, `undefined` values, or non-string types, Postgres might reject. Add a sanitization step in the route just before persistence:

```ts
const suggestions = parseSuggestions(responseText);

// Sanitize before persistence — strip anything not in the Suggestion shape
const sanitized = suggestions
  .filter((s) => typeof s.label === 'string' && typeof s.prompt === 'string')
  .map((s) => ({
    label: s.label.slice(0, 200),     // cap to reasonable size
    prompt: s.prompt.slice(0, 2000),  // cap to reasonable size
  }));

console.log('[suggestions] parsed/sanitized counts:', {
  parsed: suggestions.length,
  sanitized: sanitized.length,
});

// ... then use `sanitized` in the prisma.update and the response
```

Update the response too:

```ts
return NextResponse.json({ suggestions: sanitized });
```

### Part 4 — Verify the migration applied

If `Message.suggestionsJson` was added recently but the migration didn't run, the column might not exist in the DB even though Prisma's client expects it. Run:

```bash
npx prisma db push
```

Or check via psql:

```sql
\d "Message"
```

The column should appear as `suggestionsJson | jsonb |` (nullable). If absent, the schema change wasn't applied.

### Part 5 — Add a test endpoint for manual verification

Optional but useful: add a tiny GET endpoint that returns the persisted suggestions for a message, so the user can verify without running psql:

`src/app/api/chats/[id]/messages/[msgId]/suggestions/route.ts` — add GET handler:

```ts
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> },
) {
  const { msgId } = await params;
  const msg = await prisma.message.findUnique({
    where: { id: msgId },
    select: { id: true, suggestionsJson: true, role: true, createdAt: true },
  });
  return NextResponse.json({ message: msg });
}
```

Then in browser:
```
http://localhost:3001/api/chats/<chat-id>/messages/<msg-id>/suggestions
```

Returns the row directly. If `suggestionsJson` is null after a successful POST, persistence is broken; if populated, it worked.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- The suggestions route logs `[suggestions] persisted` on success or `[suggestions] PERSISTENCE FAILED` on error, with full diagnostic context.
- The cast uses `Prisma.InputJsonValue`, not `as object[]`.
- Sanitization filters parsed suggestions to valid `{ label: string, prompt: string }` shape only.
- Optional GET endpoint returns the persisted state for manual verification.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. **Send a message.** Watch npm run dev terminal. Look for one of:
   - `[suggestions] persisted: { msgId, suggestionCount: 3, persistedJson: [...] }` — success; persisted to DB
   - `[suggestions] PERSISTENCE FAILED: { error, stack, suggestionsShape }` — error visible; copy the error message and share for diagnosis

2. **DB verification.** After the message, query:
   ```sql
   SELECT "suggestionsJson" FROM "Message" 
   WHERE id = '<msgId from log>';
   ```
   Should return a populated JSON array, not null.

3. **GET endpoint verification.** Open in browser:
   ```
   http://localhost:3001/api/chats/<chat-id>/messages/<msg-id>/suggestions
   ```
   Should return `{ "message": { "id": "...", "suggestionsJson": [{...}, {...}, {...}], "role": "assistant" } }`.

4. **Pills appear and stay.** Send a directive. After ~10 seconds, pills should appear and remain visible (no flash-and-disappear).

5. **Pills persist on reload.** Reload the page. Pills should still be visible (now coming from DB-persisted state).

6. **Disk-avoidance regression.** Generate an image and a video. Confirm `ssh <gpu-vm> ls /models/ComfyUI/output/*.png 2>&1` returns "no such file."

---

## Out of scope

- Refactoring the suggestions route to be more defensive in general.
- Adding retry logic for the persistence step.
- Changing the SUGGESTIONS_SYSTEM_PROMPT (separate concern).
- Adding telemetry / metrics for suggestions success rate.
- Removing the diagnostic logs after fix lands — keep them; they're cheap and useful.
- Changing the schema to add an `errorMsg` column for failed suggestions.

---

## Documentation

In CLAUDE.md, under the existing Suggestions section:

> **Persistence diagnostics.** The suggestions route logs `[suggestions] persisted` (success) or `[suggestions] PERSISTENCE FAILED` (Prisma error) on every call. The cast `as unknown as Prisma.InputJsonValue` is required for Postgres jsonb columns; the previous `as object[]` cast was insufficient and silently failed. A GET handler at the same route returns persisted state for manual verification without psql.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
