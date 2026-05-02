import { NextRequest, NextResponse } from 'next/server';
import { getComfyWSManager } from '@/lib/comfyws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { promptId: string } },
) {
  const manager = getComfyWSManager();
  manager.removeJob(params.promptId);
  return NextResponse.json({ ok: true });
}
