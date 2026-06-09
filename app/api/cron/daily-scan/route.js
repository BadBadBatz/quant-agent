export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { GET as marketOpen } from '../market-open/route';

export async function GET(request) {
  return marketOpen(request);
}
