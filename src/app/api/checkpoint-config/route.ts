import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');

  // No name = return all configs (used by dropdowns to populate friendly names)
  if (!name) {
    try {
      const configs = await prisma.checkpointConfig.findMany();
      return NextResponse.json(configs);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  try {
    const config = await prisma.checkpointConfig.findUnique({
      where: { checkpointName: name },
    });
    if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: {
    checkpointName: string;
    friendlyName: string;
    baseModel?: string;
    defaultWidth: number;
    defaultHeight: number;
    defaultPositivePrompt: string;
    defaultNegativePrompt: string;
    description?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { checkpointName, friendlyName, baseModel, defaultWidth, defaultHeight, defaultPositivePrompt, defaultNegativePrompt, description } = body;
  if (!checkpointName) return NextResponse.json({ error: 'checkpointName required' }, { status: 400 });

  const data = {
    friendlyName: friendlyName ?? '',
    baseModel: baseModel ?? '',
    defaultWidth,
    defaultHeight,
    defaultPositivePrompt,
    defaultNegativePrompt,
    description: description?.trim() || null,
  };
  try {
    const config = await prisma.checkpointConfig.upsert({
      where: { checkpointName },
      create: { checkpointName, ...data },
      update: data,
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
