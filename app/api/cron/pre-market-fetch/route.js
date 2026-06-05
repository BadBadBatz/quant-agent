export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getBars } from '@/lib/alpaca';
import { calculateRSI, calculateMA } from '@/lib/indicators';
import { saveMacroContext } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SECTOR_ETFS = ['XLK','XLE','XLF','XLV','XLI','XLY','XLP'];

const FOMC_DATES = [
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30',
  '2025-09-17','2025-11-05','2025-12-17','2026-01-28','2026-03-18',
  '2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16',
];

function daysToNextFomc() {
  const now = Date.now();
  const upcoming = FOMC_DATES.map(d => new Date(d).getTime()).filter(t => t >= now).sort();
  if (!upcoming.length) return 999;
  return Math.ceil((upcoming[0] - now) / 86400000);
}

function isFomcWeek() {
  const now = new Date();
  const mon = new Date(now); mon.setDate(now.getDate() - now.getDay() + 1); mon.setHours(0,0,0,0);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  return FOMC_DATES.some(d => { const fd = new Date(d); return fd >= mon && fd <= fri; });
}

async function fetchNewsHeadlines() {
  if (!process.env.POLYGON_API_KEY) return [];
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/reference/news?ticker=SPY&limit=3&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const d = await r.json();
    return (d.results || []).slice(0, 3).map(n => ({ title: n.title, published: n.published_utc }));
  } catch { return []; }
}

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // SPY indicators
    const spyBars = await getBars('SPY', '1Day', 60);
    const spyCloses = spyBars.map(b => b.ClosePrice);
    const spyLatest = spyBars[spyBars.length - 1];
    const spyPrev5  = spyBars[spyBars.length - 6];

    const spyRsi     = parseFloat(calculateRSI(spyCloses).toFixed(1));
    const spy5dayRet = parseFloat(((spyLatest.ClosePrice / spyPrev5.ClosePrice - 1) * 100).toFixed(2));
    const regime     = spyRsi > 60 ? 'bull' : spyRsi < 40 ? 'bear' : 'neutral';

    // Sector ETF performance
    const sectorPerf = {};
    for (const etf of SECTOR_ETFS) {
      try {
        const bars  = await getBars(etf, '1Day', 6);
        const today = bars[bars.length - 1];
        const prev  = bars[bars.length - 6] || bars[0];
        sectorPerf[etf] = parseFloat(((today.ClosePrice / prev.ClosePrice - 1) * 100).toFixed(2));
      } catch { sectorPerf[etf] = null; }
    }

    // News headlines
    const topHeadlines = await fetchNewsHeadlines();

    const ctx = await saveMacroContext({
      spy_5day_return: spy5dayRet,
      spy_rsi:         spyRsi,
      regime,
      sector_perf:     sectorPerf,
      top_headlines:   topHeadlines,
      days_to_fomc:    daysToNextFomc(),
      is_fomc_week:    isFomcWeek(),
    });

    return NextResponse.json({ ok: true, regime, spyRsi, spy5dayRet, id: ctx.id });
  } catch (err) {
    console.error('[pre-market-fetch]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
