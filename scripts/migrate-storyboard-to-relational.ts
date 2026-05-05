/**
 * One-shot migration: convert Project.storyboardJson rows to Storyboard table rows.
 *
 * Run BEFORE npx prisma db push (which drops storyboardJson).
 * Safe to run multiple times — skips projects that already have Storyboard rows.
 *
 * Usage:
 *   npx tsx scripts/migrate-storyboard-to-relational.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface OldStoryboard {
  scenes: unknown[];
  storyIdea: string;
  generatedAt: string;
  quickGenerate?: boolean;
}

async function main() {
  // Use $queryRaw to read the column before it's dropped by db push.
  // If the column doesn't exist yet (already dropped), the query will fail
  // and we exit cleanly — nothing to migrate.
  let rows: { id: string; storyboardJson: unknown }[];
  try {
    rows = await prisma.$queryRaw`
      SELECT id, "storyboardJson"
      FROM "Project"
      WHERE "storyboardJson" IS NOT NULL
    `;
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes('storyboardJson') || msg.includes('column')) {
      console.log('storyboardJson column not found — already migrated or schema not yet pushed. Nothing to do.');
      return;
    }
    throw err;
  }

  console.log(`Found ${rows.length} project(s) with storyboardJson to migrate.`);

  for (const row of rows) {
    const existing = await prisma.storyboard.findFirst({ where: { projectId: row.id } });
    if (existing) {
      console.log(`  Project ${row.id}: already has a Storyboard row — skipping.`);
      continue;
    }

    const old = row.storyboardJson as OldStoryboard;
    if (!old || typeof old !== 'object' || !Array.isArray(old.scenes)) {
      console.warn(`  Project ${row.id}: storyboardJson malformed — skipping.`);
      continue;
    }

    await prisma.storyboard.create({
      data: {
        projectId: row.id,
        name: 'Storyboard',
        scenesJson: old.scenes as object[],
        storyIdea: old.storyIdea ?? '',
        generatedAt: old.generatedAt ? new Date(old.generatedAt) : new Date(),
        quickGenerate: old.quickGenerate ?? false,
        position: 0,
      },
    });
    console.log(`  Project ${row.id}: migrated storyboard with ${old.scenes.length} scene(s).`);
  }

  console.log('Migration complete.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
