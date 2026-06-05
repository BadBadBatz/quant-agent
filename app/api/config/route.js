import { NextResponse } from 'next/server';
import { getConfigRows, updateConfig } from '@/lib/supabase';

export async function GET() {
  try {
    const rows = await getConfigRows();
    return NextResponse.json({ config: rows });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Auth is enforced by middleware (session required) — no extra secret needed.
export async function PUT(request) {
  try {
    const { key, value } = await request.json();
    if (!key || value === undefined) {
      return NextResponse.json({ error: 'key and value required' }, { status: 400 });
    }
    const updated = await updateConfig(key, String(value));
    return NextResponse.json({ updated });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
