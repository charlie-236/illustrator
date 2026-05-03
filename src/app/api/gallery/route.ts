import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const cursorParam = url.searchParams.get('cursor');
  const favoritesOnly = url.searchParams.get('isFavorite') === 'true';
  const defaultLimit = parseInt(process.env.GALLERY_PAGE_SIZE ?? '30', 10);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? String(defaultLimit), 10)));

  const cursor = cursorParam ? new Date(cursorParam) : undefined;

  const mediaTypeParam = url.searchParams.get('mediaType');

  const where = {
    ...(favoritesOnly ? { isFavorite: true } : {}),
    ...(cursor ? { createdAt: { lt: cursor } } : {}),
    ...(mediaTypeParam ? { mediaType: mediaTypeParam } : {}),
  };

  try {
    const records = await prisma.generation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        project: { select: { name: true } },
        parentProject: { select: { name: true } },
      },
    });

    const serialized = records.map((g) => ({
      ...g,
      seed: g.seed.toString(),
      createdAt: g.createdAt.toISOString(),
      project: undefined,
      parentProject: undefined,
      projectName: g.project?.name ?? null,
      parentProjectName: g.parentProject?.name ?? null,
    }));

    const nextCursor = records.length === limit
      ? records[records.length - 1].createdAt.toISOString()
      : null;

    return NextResponse.json({ records: serialized, nextCursor });
  } catch (err) {
    console.error('[/api/gallery]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
