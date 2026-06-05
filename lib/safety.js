import { getConfig, getMonthStartSnapshot, pauseSystem } from './supabase.js';
import { getAccount } from './alpaca.js';
import { BLACKOUT_RULES } from './signals.js';

export { pauseSystem };

export async function checkSafetyGates() {
  const cfg = await getConfig();

  if (cfg.system_paused === 'true') {
    return { blocked: true, reason: 'System paused by user' };
  }

  // Monthly drawdown gate — compare LIVE account value (not a stale 4pm
  // snapshot) against the value at the start of the month, so the auto-pause
  // can trigger intraday.
  const [account, monthStart] = await Promise.all([
    getAccount().catch(() => null),
    getMonthStartSnapshot(),
  ]);

  const liveValue = account ? parseFloat(account.portfolio_value) : null;

  if (liveValue != null && monthStart && monthStart.total_value > 0) {
    const drawdown = (liveValue - monthStart.total_value) / monthStart.total_value;
    if (drawdown < BLACKOUT_RULES.monthly_drawdown) {
      await pauseSystem(
        `Auto-paused: monthly drawdown ${(drawdown * 100).toFixed(1)}% exceeded -10%`
      );
      return { blocked: true, reason: `Monthly drawdown limit hit (${(drawdown * 100).toFixed(1)}%)` };
    }
  }

  return { blocked: false };
}

export async function verifyCronSecret(request) {
  if (!process.env.CRON_SECRET) return true; // Not configured = allow (dev mode)

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;

  // Fallbacks for manual testing (curl with a header or ?secret= query param).
  const manual =
    request.headers.get('x-cron-secret') ||
    request.nextUrl?.searchParams?.get('secret');
  return manual === process.env.CRON_SECRET;
}

export function isMarketHours() {
  const now = new Date();
  // Convert to ET
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();
  const min = et.getMinutes();
  const totalMin = hour * 60 + min;

  if (day === 0 || day === 6) return false; // weekends
  return totalMin >= 570 && totalMin <= 960; // 9:30am–4:00pm ET
}
