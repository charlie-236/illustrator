import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const chats = await prisma.chat.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
  });

  return NextResponse.json({
    chats: chats.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messageCount: c._count.messages,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: { name?: string; samplingPresetId?: string | null } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine
  }

  const name = (body.name?.trim()) || 'Untitled chat';
  const contextLimit = parseInt(process.env.WRITER_DEFAULT_CONTEXT_LIMIT ?? '64000', 10);

  const chat = await prisma.chat.create({
    data: {
      name,
      contextLimit,
      samplingPresetId: body.samplingPresetId ?? null,
    },
  });

  return NextResponse.json({ chat: serializeChat(chat) }, { status: 201 });
}

function serializeChat(chat: {
  id: string;
  name: string;
  systemPromptOverride: string | null;
  samplingPresetId: string | null;
  samplingOverridesJson: unknown;
  contextLimit: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: chat.id,
    name: chat.name,
    systemPromptOverride: chat.systemPromptOverride,
    samplingPresetId: chat.samplingPresetId,
    samplingOverridesJson: chat.samplingOverridesJson ?? null,
    contextLimit: chat.contextLimit,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}
