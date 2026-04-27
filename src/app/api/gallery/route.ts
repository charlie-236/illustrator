import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(url.searchParams.get('limit') ?? '20', 10));
  const favoritesOnly = url.searchParams.get('isFavorite') === 'true';

  const where = favoritesOnly ? { isFavorite: true } : {};

  try {
    const [total, items] = await Promise.all([
      prisma.generation.count({ where }),
      prisma.generation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return NextResponse.json({
      items: items.map((g) => ({ ...g, seed: g.seed.toString(), createdAt: g.createdAt.toISOString() })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[/api/gallery]', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
