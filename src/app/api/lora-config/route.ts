import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { filterSystemLoras } from '@/lib/systemLoraFilter';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');

  // No name = return all configs
  if (!name) {
    try {
      const configs = await prisma.loraConfig.findMany();
      return NextResponse.json(filterSystemLoras(configs));
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  try {
    const config = await prisma.loraConfig.findUnique({ where: { loraName: name } });
    if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: {
    loraName: string;
    friendlyName: string;
    triggerWords: string;
    baseModel: string;
    category?: string;
    description?: string;
    appliesToHigh?: boolean;
    appliesToLow?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { loraName, friendlyName, triggerWords, baseModel, category, description } = body;
  if (!loraName) return NextResponse.json({ error: 'loraName required' }, { status: 400 });

  const shared = {
    friendlyName: friendlyName ?? '',
    triggerWords: triggerWords ?? '',
    baseModel: baseModel ?? '',
    category: category?.trim() || null,
    description: description?.trim() || null,
    ...(body.appliesToHigh !== undefined && { appliesToHigh: Boolean(body.appliesToHigh) }),
    ...(body.appliesToLow !== undefined && { appliesToLow: Boolean(body.appliesToLow) }),
  };

  try {
    const config = await prisma.loraConfig.upsert({
      where: { loraName },
      create: { loraName, ...shared },
      update: shared,
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
