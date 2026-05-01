import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');

  // No name = return all configs
  if (!name) {
    try {
      const configs = await prisma.embeddingConfig.findMany({
        orderBy: { embeddingName: 'asc' },
      });
      return NextResponse.json(configs);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  try {
    const config = await prisma.embeddingConfig.findUnique({ where: { embeddingName: name } });
    if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: {
    embeddingName: string;
    friendlyName: string;
    triggerWords: string;
    baseModel: string;
    category?: string;
    description?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { embeddingName, friendlyName, triggerWords, baseModel, category, description } = body;
  if (!embeddingName) return NextResponse.json({ error: 'embeddingName required' }, { status: 400 });

  const data = {
    friendlyName: friendlyName ?? '',
    triggerWords: triggerWords ?? '',
    baseModel: baseModel ?? '',
    category: category?.trim() || null,
    description: description?.trim() || null,
  };
  try {
    const config = await prisma.embeddingConfig.upsert({
      where: { embeddingName },
      create: { embeddingName, ...data },
      update: data,
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
