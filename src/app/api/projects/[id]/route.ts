import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await prisma.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    console.error('[DELETE /api/projects/[id]]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
