import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BranchRequest {
  parentMessageId: string;
  branchIndex: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let body: BranchRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { parentMessageId, branchIndex } = body;
  if (!parentMessageId || branchIndex === undefined) {
    return new Response(JSON.stringify({ error: 'parentMessageId and branchIndex are required' }), { status: 400 });
  }

  const chatId = params.id;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { messages: { where: { parentMessageId, branchIndex } } },
  });

  if (!chat) {
    return new Response(JSON.stringify({ error: 'Chat not found' }), { status: 404 });
  }

  if (chat.messages.length === 0) {
    return new Response(
      JSON.stringify({ error: 'No message found with that parentMessageId and branchIndex' }),
      { status: 400 },
    );
  }

  const activeBranches = (chat.activeBranchesJson as Record<string, number> | null) ?? {};
  const updatedBranches = { ...activeBranches, [parentMessageId]: branchIndex };

  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: { activeBranchesJson: updatedBranches },
    include: {
      samplingPreset: true,
      messages: { orderBy: [{ createdAt: 'asc' }, { branchIndex: 'asc' }] },
    },
  });

  return Response.json({ ok: true, chat: updatedChat });
}
