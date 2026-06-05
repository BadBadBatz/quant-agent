import { NextResponse } from 'next/server';
import { getDecisions } from '@/lib/supabase';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '100');
  const offset = parseInt(searchParams.get('offset') || '0');
  const symbol = searchParams.get('symbol') || undefined;
  const decision = searchParams.get('decision') || undefined;

  try {
    const decisions = await getDecisions({ limit, offset, symbol, decision });
    return NextResponse.json({ decisions, limit, offset });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
