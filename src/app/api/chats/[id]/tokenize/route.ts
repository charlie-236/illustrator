import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { DIRECTOR_MODE_SYSTEM_PROMPT } from '@/lib/writerSystemPrompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: { pendingUserMessage?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Optional body
  }

  const chat = await prisma.chat.findUnique({
    where: { id: params.id },
    include: {
      messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
    },
  });

  if (!chat) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const systemPrompt = chat.systemPromptOverride ?? DIRECTOR_MODE_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (body.pendingUserMessage?.trim()) {
    messages.push({ role: 'user', content: body.pendingUserMessage.trim() });
  }

  const endpoint = process.env.WRITER_LLM_TOKENIZE_ENDPOINT;
  const model = process.env.WRITER_LLM_MODEL;

  let tokenCount = 0;

  if (endpoint && model) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { count?: number; tokens?: unknown[] };
        tokenCount = data.count ?? data.tokens?.length ?? 0;
      }
    } catch {
      // Non-fatal; return 0 as the count
    }
  }

  return NextResponse.json({ tokenCount, contextLimit: chat.contextLimit });
}
