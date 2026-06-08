# Railway Cron Services

Railway cron schedules are UTC. The original plan is in America/New_York, so use the UTC equivalents below while Eastern time is daylight saving time.

| Service | Schedule | Start command |
| --- | --- | --- |
| `pre-market-fetch` | `30 10 * * 1-5` | `curl -sS --fail-with-body -H 'Authorization: Bearer $CRON_SECRET' https://quant-agent-production.up.railway.app/api/cron/pre-market-fetch` |
| `market-open` | `30 13 * * 1-5` | `curl -sS --fail-with-body -H 'Authorization: Bearer $CRON_SECRET' https://quant-agent-production.up.railway.app/api/cron/market-open` |
| `position-monitor` | `*/30 13-20 * * 1-5` | `curl -sS --fail-with-body -H 'Authorization: Bearer $CRON_SECRET' https://quant-agent-production.up.railway.app/api/cron/position-monitor` |
| `market-close` | `0 20 * * 1-5` | `curl -sS --fail-with-body -H 'Authorization: Bearer $CRON_SECRET' https://quant-agent-production.up.railway.app/api/cron/eod` |
| `outcome-writer` | `15 20 * * 1-5` | `curl -sS --fail-with-body -H 'Authorization: Bearer $CRON_SECRET' https://quant-agent-production.up.railway.app/api/cron/outcome-writer` |

Required variables:

- `CRON_BASE_URL`: deployed app URL, for example `https://your-service.up.railway.app`
- `CRON_SECRET`: shared bearer token for cron routes
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ANTHROPIC_API_KEY`
- `POLYGON_API_KEY`, optional for news enrichment

Keep the Vercel dashboard deployed for UI only. Disable Vercel cron jobs after the Railway cron services are active to avoid duplicate trades.
