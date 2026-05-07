import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SUGGESTIONS_SYSTEM_PROMPT } from '@/lib/writerSuggestionsPrompt';
import { resolveActivePath } from '@/lib/chatBranches';
import type { MessageRecord, Suggestion } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseSuggestions(text: string): Suggestion[] {
  const blocks = text.split(/\[SUGGESTION \d+\]/i).filter((b) => b.trim().length > 0);
  const suggestions: Suggestion[] = [];

  for (const block of blocks) {
    const labelMatch = block.match(/LABEL:\s*(.+?)(?:\n|$)/i);
    const promptMatch = block.match(/PROMPT:\s*([\s\S]+?)(?=\n\[SUGGESTION|$)/i);

    if (labelMatch && promptMatch) {
      const label = labelMatch[1].trim();
      const prompt = promptMatch[1].trim();
      if (label.length > 0 && prompt.length > 0) {
        suggestions.push({ label, prompt });
      }
    }

    if (suggestions.length === 3) break;
  }

  return suggestions;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; msgId: string } },
) {
  const { id: chatId, msgId } = params;

  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
      },
    });

    if (!chat) {
      return NextResponse.json({ suggestions: [] });
    }

    if (!chat.suggestionsEnabled) {
      return NextResponse.json({ suggestions: null });
    }

    const target = chat.messages.find((m) => m.id === msgId);
    if (!target || target.role !== 'assistant') {
      return NextResponse.json({ suggestions: [] });
    }

    // If already cached, return the cached value
    if (target.suggestionsJson !== null && target.suggestionsJson !== undefined) {
      return NextResponse.json({ suggestions: target.suggestionsJson as unknown as Suggestion[] });
    }

    const endpoint = process.env.WRITER_LLM_ENDPOINT;
    const model = process.env.WRITER_LLM_MODEL;

    if (!endpoint || !model) {
      return NextResponse.json({ suggestions: [] });
    }

    // Build active path up to and including the target message
    const dbMessages: MessageRecord[] = chat.messages.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      parentMessageId: m.parentMessageId,
      branchIndex: m.branchIndex,
      suggestionsJson: null,
      createdAt: m.createdAt.toISOString(),
    }));

    const activeBranches = (chat.activeBranchesJson as Record<string, number> | null) ?? null;
    const activePath = resolveActivePath(dbMessages, activeBranches);

    // Slice up to and including the target message
    const targetIdx = activePath.findIndex((m) => m.id === msgId);
    const historyPath = targetIdx >= 0 ? activePath.slice(0, targetIdx + 1) : activePath;

    const history = [
      { role: 'system', content: SUGGESTIONS_SYSTEM_PROMPT },
      ...historyPath.map((m) => ({ role: m.role, content: m.content })),
    ];

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 10000);

    let responseText = '';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          model,
          messages: history,
          stream: false,
          temperature: 0.9,
          max_tokens: 500,
        }),
      });

      if (!res.ok) {
        return NextResponse.json({ suggestions: [] });
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      responseText = data.choices?.[0]?.message?.content ?? '';
    } catch {
      return NextResponse.json({ suggestions: [] });
    } finally {
      clearTimeout(timeoutId);
    }

    const suggestions = parseSuggestions(responseText);

    // Persist to DB
    await prisma.message.update({
      where: { id: msgId },
      data: { suggestionsJson: suggestions as object[] },
    }).catch(() => {});

    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
