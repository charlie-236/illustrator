import { NextResponse } from 'next/server';
import { getComfyWSManager } from '@/lib/comfyws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const manager = getComfyWSManager();
  const jobs = manager.getActiveJobs();
  return NextResponse.json({ jobs });
}
