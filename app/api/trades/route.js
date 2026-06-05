export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getTrades } from '@/lib/supabase';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');

  try {
    const trades = await getTrades({ limit, offset });
    return NextResponse.json({ trades, limit, offset });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
