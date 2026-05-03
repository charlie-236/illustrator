import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

function validateDefaults(body: {
  defaultFrames?: unknown;
  defaultSteps?: unknown;
  defaultCfg?: unknown;
  defaultWidth?: unknown;
  defaultHeight?: unknown;
}): string | null {
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

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { generations: true } },
        generations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { filePath: true, mediaType: true },
        },
      },
    });

    const result = projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      styleNote: p.styleNote,
      clipCount: p._count.generations,
      coverFrame: p.generations[0]?.filePath ?? null,
      coverMediaType: p.generations[0]?.mediaType ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));

    return NextResponse.json({ projects: result });
  } catch (err) {
    console.error('[GET /api/projects]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: {
    name?: unknown;
    description?: unknown;
    styleNote?: unknown;
    defaultFrames?: unknown;
    defaultSteps?: unknown;
    defaultCfg?: unknown;
    defaultWidth?: unknown;
    defaultHeight?: unknown;
    defaultLightning?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return NextResponse.json({ error: 'name is required and must be a non-empty string' }, { status: 400 });
  }

  const validationError = validateDefaults(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const defaultLightning = body.defaultLightning === true ? true
    : body.defaultLightning === false ? false
    : null;

  try {
    const project = await prisma.project.create({
      data: {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        styleNote: typeof body.styleNote === 'string' ? body.styleNote.trim() || null : null,
        defaultFrames: typeof body.defaultFrames === 'number' ? body.defaultFrames : null,
        defaultSteps: typeof body.defaultSteps === 'number' ? body.defaultSteps : null,
        defaultCfg: typeof body.defaultCfg === 'number' ? body.defaultCfg : null,
        defaultWidth: typeof body.defaultWidth === 'number' ? body.defaultWidth : null,
        defaultHeight: typeof body.defaultHeight === 'number' ? body.defaultHeight : null,
        defaultLightning,
      },
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
    }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/projects]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
