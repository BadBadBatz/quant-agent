export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { resolvePendingOutcomes } from '@/lib/outcomes';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resolved = await resolvePendingOutcomes({ holdTradingDays: 5 });

  return NextResponse.json({
    ok: true,
    resolved: {
      buys: resolved.buys.length,
      passes: resolved.passes.length,
      watches: resolved.watches.length,
    },
    errors: resolved.errors,
  });
}
