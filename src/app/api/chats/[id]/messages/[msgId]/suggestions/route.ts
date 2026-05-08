import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SUGGESTIONS_SYSTEM_PROMPT } from '@/lib/writerSuggestionsPrompt';
import { resolveActivePath } from '@/lib/chatBranches';
import type { MessageRecord, Suggestion } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cleanLabel(s: string): string {
  return s
    .trim()
    .replace(/^[\*\_\-\#\d\.\)\s]+/, '')
    .replace(/[\*\_]+/g, '')
    .replace(/^["'"“‘]|["'"”’]$/g, '')
    .replace(/\.$/, '')
    .slice(0, 80)
    .trim();
}

function cleanPrompt(s: string): string {
  return s
    .trim()
    .replace(/^[\*\_\-\s]+/, '')
    .replace(/[\*\_]{2,}/g, '')
    .slice(0, 1000)
    .trim();
}

function parseStrictFormat(text: string): Suggestion[] {
  const blocks = text.split(/\[SUGGESTION\s*\d+\]/i).filter((b) => b.trim().length > 0);
  const suggestions: Suggestion[] = [];
  for (const block of blocks) {
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)(?=\n\[SUGGESTION|\nLABEL\s*:|$)/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseNumberedFormat(text: string): Suggestion[] {
  const blocks = text.split(/\n\s*\d+[\.\)]\s+/).filter((b) => b.trim().length > 0);
  const startIdx = blocks[0]?.match(/LABEL\s*:/i) ? 0 : 1;
  const suggestions: Suggestion[] = [];
  for (let i = startIdx; i < blocks.length; i++) {
    const block = blocks[i];
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)(?=\n\s*\d+[\.\)]|\nLABEL\s*:|$)/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    } else {
      const lines = block.trim().split(/\n+/);
      if (lines.length >= 2) {
        const label = cleanLabel(lines[0]);
        const prompt = cleanPrompt(lines.slice(1).join(' '));
        if (label && prompt) suggestions.push({ label, prompt });
      }
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseMarkdownFormat(text: string): Suggestion[] {
  const blocks = text
    .split(/\n+(?:#{1,3}\s+|^\*\*)\s*(?:Suggestion\s*)?\d+[\.\):\*]*\s*\*?\*?/im)
    .filter((b) => b.trim().length > 0);
  const suggestions: Suggestion[] = [];
  for (const block of blocks) {
    const labelMatch = block.match(/LABEL\s*:\s*(.+?)(?:\n|$)/i) ?? block.match(/^(.+?)(?:\n|$)/);
    const promptMatch = block.match(/PROMPT\s*:\s*([\s\S]+?)$/i);
    if (labelMatch && promptMatch) {
      const label = cleanLabel(labelMatch[1]);
      const prompt = cleanPrompt(promptMatch[1]);
      if (label && prompt) suggestions.push({ label, prompt });
    } else if (labelMatch) {
      const lines = block.trim().split(/\n+/);
      if (lines.length >= 2) {
        const label = cleanLabel(lines[0]);
        const prompt = cleanPrompt(lines.slice(1).join(' '));
        if (label && prompt) suggestions.push({ label, prompt });
      }
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseParagraphFallback(text: string): Suggestion[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
  const suggestions: Suggestion[] = [];
  for (const para of paragraphs) {
    const cleaned = para.replace(/^[\d\.\-\*\s]+/, '').trim();
    const sentenceMatch = cleaned.match(/^([^.!?\n]+[.!?])/);
    if (sentenceMatch) {
      const label = cleanLabel(sentenceMatch[1]);
      const prompt = cleanPrompt(cleaned);
      if (label && prompt) suggestions.push({ label, prompt });
    } else {
      const label = cleanLabel(cleaned.slice(0, 60));
      const prompt = cleanPrompt(cleaned);
      if (label && prompt) suggestions.push({ label, prompt });
    }
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

function parseSuggestions(text: string): Suggestion[] {
  if (!text || text.trim().length === 0) return [];

  const strict = parseStrictFormat(text);
  if (strict.length >= 2) return strict.slice(0, 3);

  const numbered = parseNumberedFormat(text);
  if (numbered.length >= 2) return numbered.slice(0, 3);

  const markdown = parseMarkdownFormat(text);
  if (markdown.length >= 2) return markdown.slice(0, 3);

  const paragraphs = parseParagraphFallback(text);
  if (paragraphs.length >= 2) return paragraphs.slice(0, 3);

  return [];
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

    console.log('[suggestions] msgId:', msgId);
    console.log('[suggestions] raw LLM response (first 1000 chars):', responseText.slice(0, 1000));

    const parsed = parseSuggestions(responseText);

    console.log('[suggestions] parsed count:', parsed.length);
    if (parsed.length === 0 && responseText.length > 0) {
      console.log('[suggestions] parse FAILED — full response:', responseText);
    }

    // Sanitize before persistence — strip anything not in the Suggestion shape
    const sanitized = parsed
      .filter((s) => typeof s.label === 'string' && typeof s.prompt === 'string')
      .map((s) => ({
        label: s.label.slice(0, 200),
        prompt: s.prompt.slice(0, 2000),
      }));

    console.log('[suggestions] parsed/sanitized counts:', {
      parsed: parsed.length,
      sanitized: sanitized.length,
    });

    // Persist to DB
    try {
      const updateResult = await prisma.message.update({
        where: { id: msgId },
        data: {
          suggestionsJson: sanitized as unknown as Prisma.InputJsonValue,
        },
      });
      console.log('[suggestions] persisted:', {
        msgId,
        suggestionCount: sanitized.length,
        persistedJson: updateResult.suggestionsJson,
      });
    } catch (err) {
      console.error('[suggestions] PERSISTENCE FAILED:', {
        msgId,
        suggestionCount: sanitized.length,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        suggestionsShape: JSON.stringify(sanitized).slice(0, 500),
      });
      // Continue to return suggestions to client — the API call itself succeeded;
      // persistence is the problem.
    }

    return NextResponse.json({ suggestions: sanitized });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; msgId: string } },
) {
  const { msgId } = params;
  const msg = await prisma.message.findUnique({
    where: { id: msgId },
    select: { id: true, suggestionsJson: true, role: true, createdAt: true },
  });
  return NextResponse.json({ message: msg });
}
