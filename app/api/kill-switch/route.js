export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getConfig, pauseSystem, resumeSystem } from '@/lib/supabase';

export async function POST(request) {
  try {
    const cfg = await getConfig();
    const currentlyPaused = cfg.system_paused === 'true';

    if (currentlyPaused) {
      await resumeSystem();
      return NextResponse.json({ system_paused: false, message: 'System resumed' });
    } else {
      await pauseSystem('Manually paused via kill switch');
      return NextResponse.json({ system_paused: true, message: 'System paused' });
    }
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const cfg = await getConfig();
    return NextResponse.json({ system_paused: cfg.system_paused === 'true' });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
