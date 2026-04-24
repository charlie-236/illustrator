import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'Missing name' }, { status: 400 });

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
    defaultWidth: number;
    defaultHeight: number;
    defaultPositivePrompt: string;
    defaultNegativePrompt: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { checkpointName, defaultWidth, defaultHeight, defaultPositivePrompt, defaultNegativePrompt } = body;
  if (!checkpointName) return NextResponse.json({ error: 'checkpointName required' }, { status: 400 });

  try {
    const config = await prisma.checkpointConfig.upsert({
      where: { checkpointName },
      create: { checkpointName, defaultWidth, defaultHeight, defaultPositivePrompt, defaultNegativePrompt },
      update: { defaultWidth, defaultHeight, defaultPositivePrompt, defaultNegativePrompt },
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
