# Batch — Prisma client touch-ups

Two tiny improvements to the Prisma client setup.

1. `src/lib/comfyws.ts`'s `finalizeJob` does `const { prisma } = await import('./prisma')` — a dynamic import inside a hot path. Static import works equally well here and is slightly faster + cleaner.
2. `src/lib/prisma.ts` sets `log: ['error']` in both dev and production via a ternary that picks the same value either way (accidental dead code). In dev it's helpful to see `query` and `warn` events too. Production stays at `['error']`.

Re-read CLAUDE.md before starting. Disk-avoidance is unaffected.

---

## Task 1 — Static import for prisma in comfyws.ts

In `src/lib/comfyws.ts`, find the line in `finalizeJob`:

```ts
const { prisma } = await import('./prisma');
```

Replace it with a static import at the top of the file:

```ts
import { prisma } from './prisma';
```

…and delete the dynamic import line inside `finalizeJob`. Use the imported `prisma` directly.

Before changing, verify there's no circular-init reason for the dynamic import. `prisma.ts` imports nothing from `comfyws.ts`. `comfyws.ts` already imports the `Prisma` namespace statically from `@prisma/client`. There should be no circular issue.

If `npm run build` fails after this change with a circular-import warning or a runtime "prisma is undefined" error, revert the static import (keep the dynamic one), and add a code comment in `comfyws.ts` near the dynamic import explaining the circular dependency for future readers. Document in the PR description that the static-import attempt was reverted.

## Task 2 — Bump Prisma log level in dev

In `src/lib/prisma.ts`, the current ternary:

```ts
export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error'] : ['error'],
  });
```

…picks `['error']` either way — the dev branch and prod branch are identical. Change the dev branch to `['query', 'warn', 'error']`:

```ts
export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'warn', 'error']
      : ['error'],
  });
```

This emits each query to stdout in dev — useful for debugging slow Studio loads or ingest issues — and stays quiet in production.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "await import.*prisma" src/lib/comfyws.ts` returns nothing (or task 1 was reverted with a comment explaining why — note this in the PR).
- `grep -n "import { prisma }" src/lib/comfyws.ts` returns one match (or task 1 was reverted).
- `src/lib/prisma.ts` differentiates dev vs prod log levels.

Manual smoke test (deferred to user):
1. Run `npm run dev`. Generate an image. Console should show Prisma `query` events in addition to errors.
2. Run via `pm2 restart illustrator` (production mode). Console should NOT show `query` events — only errors.
3. Generation end-to-end still works. Files written, DB rows created. (Confirms the prisma static import didn't break the WS finalize path.)

---

## Out of scope

- Don't change Prisma's transaction settings, retry behavior, or connection pool.
- Don't add a custom log handler / pino integration.
- Don't refactor the `global.__prisma` pattern — it's documented in CLAUDE.md and works.
- Don't touch any other dynamic imports in the codebase. Just the one in `comfyws.ts`.

---

## Documentation

No CLAUDE.md changes needed.

When done, push and create the PR via `gh pr create` per AGENTS.md.
