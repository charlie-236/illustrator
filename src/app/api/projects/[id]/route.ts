import { NextRequest, NextResponse } from 'next/server';
import { unlink } from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { getComfyWSManager } from '@/lib/comfyws';

export const dynamic = 'force-dynamic';

function validateDefaults(body: Record<string, unknown>): string | null {
  const { defaultFrames, defaultSteps, defaultCfg, defaultWidth, defaultHeight } = body;
  if (defaultFrames !== undefined && defaultFrames !== null) {
    if (!Number.isInteger(defaultFrames) || (defaultFrames as number) < 17 || (defaultFrames as number) > 121 || ((defaultFrames as number) - 1) % 8 !== 0) {
      return 'defaultFrames must be an integer satisfying (frames-1) % 8 === 0, range 17–121';
    }
  }
  if (defaultSteps !== undefined && defaultSteps !== null) {
    if (!Number.isInteger(defaultSteps) || (defaultSteps as number) < 4 || (defaultSteps as number) > 40 || (defaultSteps as number) % 2 !== 0) {
      return 'defaultSteps must be an even integer, 4–40 inclusive';
    }
  }
  if (defaultCfg !== undefined && defaultCfg !== null) {
    if (typeof defaultCfg !== 'number' || !Number.isFinite(defaultCfg as number) || (defaultCfg as number) < 1.0 || (defaultCfg as number) > 10.0) {
      return 'defaultCfg must be a number 1.0–10.0 inclusive';
    }
  }
  if (defaultWidth !== undefined && defaultWidth !== null) {
    if (!Number.isInteger(defaultWidth) || (defaultWidth as number) < 256 || (defaultWidth as number) > 1280 || (defaultWidth as number) % 32 !== 0) {
      return 'defaultWidth must be an integer multiple of 32, 256–1280 inclusive';
    }
  }
  if (defaultHeight !== undefined && defaultHeight !== null) {
    if (!Number.isInteger(defaultHeight) || (defaultHeight as number) < 256 || (defaultHeight as number) > 1280 || (defaultHeight as number) % 32 !== 0) {
      return 'defaultHeight must be an integer multiple of 32, 256–1280 inclusive';
    }
  }
  return null;
}

/** Delete a generation's file from local disk. Errors are logged but not thrown. */
async function deleteItemFile(filePath: string, outputDir: string): Promise<void> {
  const filename = filePath
    .replace('/api/images/', '')
    .replace('/generations/', '');
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  const localPath = path.join(outputDir, filename);
  try {
    await unlink(localPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[cascade-delete] unlink failed for ${localPath}:`, err);
    }
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        generations: {
          orderBy: [
            { position: 'asc' },
            { createdAt: 'asc' },
          ],
          select: {
            id: true,
            filePath: true,
            promptPos: true,
            frames: true,
            fps: true,
            width: true,
            height: true,
            position: true,
            createdAt: true,
            isFavorite: true,
            mediaType: true,
          },
        },
        stitchedExports: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            filePath: true,
            frames: true,
            fps: true,
            createdAt: true,
            promptPos: true,
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        styleNote: project.styleNote,
        defaultFrames: project.defaultFrames,
        defaultSteps: project.defaultSteps,
        defaultCfg: project.defaultCfg,
        defaultWidth: project.defaultWidth,
        defaultHeight: project.defaultHeight,
        defaultLightning: project.defaultLightning,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
      clips: project.generations.map((g) => ({
        id: g.id,
        filePath: g.filePath,
        prompt: g.promptPos,
        frames: g.frames ?? 0,
        fps: g.fps ?? 16,
        width: g.width,
        height: g.height,
        position: g.position ?? 0,
        createdAt: g.createdAt.toISOString(),
        isFavorite: g.isFavorite,
        mediaType: g.mediaType,
      })),
      stitchedExports: project.stitchedExports.map((e) => ({
        id: e.id,
        filePath: e.filePath,
        frames: e.frames,
        fps: e.fps,
        createdAt: e.createdAt.toISOString(),
        promptPos: e.promptPos,
      })),
    });
  } catch (err) {
    console.error('[GET /api/projects/[id]]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if ('name' in body && (typeof body.name !== 'string' || (body.name as string).trim() === '')) {
    return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
  }

  const validationError = validateDefaults(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if ('name' in body) data.name = (body.name as string).trim();
  if ('description' in body) data.description = typeof body.description === 'string' ? body.description.trim() || null : null;
  if ('styleNote' in body) data.styleNote = typeof body.styleNote === 'string' ? body.styleNote.trim() || null : null;
  if ('defaultFrames' in body) data.defaultFrames = body.defaultFrames ?? null;
  if ('defaultSteps' in body) data.defaultSteps = body.defaultSteps ?? null;
  if ('defaultCfg' in body) data.defaultCfg = body.defaultCfg ?? null;
  if ('defaultWidth' in body) data.defaultWidth = body.defaultWidth ?? null;
  if ('defaultHeight' in body) data.defaultHeight = body.defaultHeight ?? null;
  if ('defaultLightning' in body) {
    data.defaultLightning = body.defaultLightning === true ? true
      : body.defaultLightning === false ? false
      : null;
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data,
    });

    return NextResponse.json({
      id: project.id,
      name: project.name,
      description: project.description,
      styleNote: project.styleNote,
      defaultFrames: project.defaultFrames,
      defaultSteps: project.defaultSteps,
      defaultCfg: project.defaultCfg,
      defaultWidth: project.defaultWidth,
      defaultHeight: project.defaultHeight,
      defaultLightning: project.defaultLightning,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[PATCH /api/projects/[id]]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const cascadeParam = req.nextUrl.searchParams.get('cascade');
  if (cascadeParam !== null && cascadeParam !== 'true' && cascadeParam !== 'false') {
    return NextResponse.json({ error: 'cascade must be "true" or "false"' }, { status: 400 });
  }
  const cascade = cascadeParam === 'true';

  if (!cascade) {
    // ── Keep-items path (existing behavior) ─────────────────────────────────
    try {
      await prisma.$transaction([
        prisma.generation.updateMany({
          where: { projectId: id },
          data: { position: null },
        }),
        prisma.project.delete({ where: { id } }),
      ]);
      return NextResponse.json({ ok: true });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      console.error('[DELETE /api/projects/[id]]', err);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
  }

  // ── Cascade delete path ──────────────────────────────────────────────────

  const outputDir = process.env.IMAGE_OUTPUT_DIR;
  if (!outputDir) {
    return NextResponse.json({ error: 'IMAGE_OUTPUT_DIR not configured' }, { status: 500 });
  }

  // Verify project exists first
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 1. Abort in-flight jobs related to this project (fire-and-forget)
  try {
    const manager = getComfyWSManager();
    const aborted = manager.abortJobsByProjectId(id);
    if (aborted.length > 0) {
      console.log(`[cascade-delete] Aborted ${aborted.length} in-flight job(s) for project ${id}: ${aborted.join(', ')}`);
    }
  } catch (err) {
    console.error('[cascade-delete] abortJobsByProjectId failed:', err);
  }

  // 2. Find all items the cascade will touch
  const [sourceItems, stitchedExports] = await Promise.all([
    prisma.generation.findMany({
      where: { projectId: id },
      select: { id: true, filePath: true },
    }),
    prisma.generation.findMany({
      where: { parentProjectId: id },
      select: { id: true, filePath: true },
    }),
  ]);
  const allToDelete = [...sourceItems, ...stitchedExports];

  // 3. Delete files from disk (errors log but don't abort)
  await Promise.all(allToDelete.map((item) => deleteItemFile(item.filePath, outputDir)));

  // 4. Delete DB rows in a single transaction
  try {
    await prisma.$transaction([
      prisma.generation.deleteMany({
        where: {
          OR: [
            { projectId: id },
            { parentProjectId: id },
          ],
        },
      }),
      prisma.project.delete({ where: { id } }),
    ]);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[DELETE /api/projects/[id] cascade]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  // 5. Straggler sweep — catch any rows that appeared between abort and deleteMany
  //    (e.g. a stitch ffmpeg that completed before SIGTERM landed)
  const stragglers = await prisma.generation.findMany({
    where: { OR: [{ projectId: id }, { parentProjectId: id }] },
    select: { id: true, filePath: true },
  }).catch(() => [] as { id: string; filePath: string }[]);

  if (stragglers.length > 0) {
    console.warn(`[cascade-delete] ${stragglers.length} straggler(s) appeared after deleteMany — abort race window`);
    await Promise.all(stragglers.map((s) => deleteItemFile(s.filePath, outputDir).catch(() => {})));
    await prisma.generation.deleteMany({ where: { id: { in: stragglers.map((s) => s.id) } } }).catch((err) => {
      console.error('[cascade-delete] straggler deleteMany failed:', err);
    });
  }

  return NextResponse.json({
    ok: true,
    deletedItems: sourceItems.length,
    deletedStitches: stitchedExports.length,
  });
}
