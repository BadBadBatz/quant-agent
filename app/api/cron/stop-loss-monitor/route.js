export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { GET as positionMonitor } from '../position-monitor/route';

export async function GET(request) {
  return positionMonitor(request);
}
