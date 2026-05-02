import { NextRequest, NextResponse } from 'next/server';
import { getComfyWSManager } from '@/lib/comfyws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { promptId: string } },
) {
  const manager = getComfyWSManager();
  const ok = manager.abortJob(params.promptId);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
