export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// Session-protected trigger — middleware already enforces auth, so no
// CRON_SECRET check needed here. We call the scan endpoint server-side
// so the secret never touches the browser.
export async function POST(request) {
  const origin = new URL(request.url).origin;

  const res = await fetch(`${origin}/api/cron/daily-scan`, {
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
