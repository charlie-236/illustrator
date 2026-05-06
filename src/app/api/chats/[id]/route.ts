import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { SamplingParams } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const chat = await prisma.chat.findUnique({
    where: { id: params.id },
    include: {
      samplingPreset: true,
      messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
    },
  });

  if (!chat) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ chat: serializeChatRecord(chat) });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: {
    name?: string;
    systemPromptOverride?: string | null;
    samplingPresetId?: string | null;
    samplingOverridesJson?: Partial<SamplingParams> | null;
    contextLimit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const chat = await prisma.chat.findUnique({ where: { id: params.id } });
  if (!chat) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 100) {
      return NextResponse.json({ error: 'name must be 1–100 characters' }, { status: 400 });
    }
    data.name = name;
  }

  if ('systemPromptOverride' in body) {
    data.systemPromptOverride = body.systemPromptOverride ?? null;
  }

  if ('samplingPresetId' in body) {
    data.samplingPresetId = body.samplingPresetId ?? null;
  }

  if ('samplingOverridesJson' in body) {
    data.samplingOverridesJson = body.samplingOverridesJson ?? null;
  }

  if (body.contextLimit !== undefined) {
    const limit = body.contextLimit;
    if (!Number.isInteger(limit) || limit < 1024 || limit > 262144) {
      return NextResponse.json({ error: 'contextLimit must be an integer 1024–262144' }, { status: 400 });
    }
    data.contextLimit = limit;
  }

  const updated = await prisma.chat.update({
    where: { id: params.id },
    data,
    include: { samplingPreset: true, messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] } },
  });

  return NextResponse.json({ chat: serializeChatRecord(updated) });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const chat = await prisma.chat.findUnique({ where: { id: params.id } });
  if (!chat) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await prisma.chat.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}

type ChatWithRelations = {
  id: string;
  name: string;
  systemPromptOverride: string | null;
  samplingPresetId: string | null;
  samplingPreset: {
    id: string;
    name: string;
    paramsJson: unknown;
    isBuiltIn: boolean;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  samplingOverridesJson: unknown;
  activeBranchesJson: unknown;
  contextLimit: number;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    chatId: string;
    role: string;
    content: string;
    parentMessageId: string | null;
    branchIndex: number;
    createdAt: Date;
  }>;
};

function serializeChatRecord(chat: ChatWithRelations) {
  return {
    id: chat.id,
    name: chat.name,
    systemPromptOverride: chat.systemPromptOverride,
    samplingPresetId: chat.samplingPresetId,
    samplingPreset: chat.samplingPreset
      ? {
          id: chat.samplingPreset.id,
          name: chat.samplingPreset.name,
          paramsJson: chat.samplingPreset.paramsJson,
          isBuiltIn: chat.samplingPreset.isBuiltIn,
          createdAt: chat.samplingPreset.createdAt.toISOString(),
          updatedAt: chat.samplingPreset.updatedAt.toISOString(),
        }
      : null,
    samplingOverridesJson: (chat.samplingOverridesJson as Partial<SamplingParams>) ?? null,
    activeBranchesJson: (chat.activeBranchesJson as Record<string, number> | null) ?? null,
    contextLimit: chat.contextLimit,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: chat.messages.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      parentMessageId: m.parentMessageId,
      branchIndex: m.branchIndex,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
