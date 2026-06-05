import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Robustly extract a JSON object from a model response: strip code fences,
// try a direct parse, then fall back to the first balanced {...} block.
function parseJsonResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`No JSON object found in model response: ${cleaned.slice(0, 120)}`);
  }
}

export async function claudeReason(stockData, portfolioState, systemRules, marketContext = null) {
  // Build the market context block if available (Phase 4)
  const contextBlock = marketContext ? `
MARKET CONTEXT (Phase 2/3 enrichment):
Regime         : ${marketContext.regime.toUpperCase()}  (SPY RSI ${marketContext.spyRsi} + 20d trend ${marketContext.spy20dTrend > 0 ? '+' : ''}${marketContext.spy20dTrend}%)
SPY RSI        : ${marketContext.spyRsi}
SPY vs MA50    : ${marketContext.spyVsMa50 > 0 ? '+' : ''}${marketContext.spyVsMa50}%
SPY 5d trend   : ${marketContext.spy5dTrend > 0 ? '+' : ''}${marketContext.spy5dTrend}%
SPY 20d trend  : ${marketContext.spy20dTrend > 0 ? '+' : ''}${marketContext.spy20dTrend}%
Sector (${(marketContext.sectorEtf || 'ETF').padEnd(3)}): RSI ${marketContext.sectorRsi}  |  5d trend ${marketContext.sector5d > 0 ? '+' : ''}${marketContext.sector5d}%  |  vs SPY: ${marketContext.sectorVsSpy > 0 ? '+' : ''}${marketContext.sectorVsSpy}%
Stock vs MA200 : ${marketContext.pctVsMa200 !== null ? `${marketContext.pctVsMa200 > 0 ? '+' : ''}${marketContext.pctVsMa200}%` : 'n/a'}
Intraday range : ${marketContext.hlRange !== null ? `${marketContext.hlRange}%` : 'n/a'}
Days to FOMC   : ${marketContext.daysToFomc}
Composite score: ${marketContext.composite.score} / 1.0  — ${marketContext.composite.interpretation}
  Top drivers  : ${marketContext.composite.topDrivers.join(', ')}

REGIME RULES (from backtesting):
${marketContext.regime === 'bull'
  ? '- BULL REGIME: SPY RSI > 60 AND 20d trend > 4%. RSI 40–60 entries historically valid here (Phase 3 backtest: 64.3% win rate in bull vs 41.2% in bear). Be willing to buy stocks with RSI up to 60 if other signals align.'
  : '- BEAR/NEUTRAL REGIME: Require RSI 25–40 strictly. Higher bar for entry — only the cleanest setups.'}
${marketContext.daysToFomc <= 7 ? '- WARNING: FOMC meeting within 7 days. Elevated macro risk — prefer watchlist over buy unless conviction is very high.' : ''}
` : '';

  const prompt = `You are a quant trading agent managing a passive investment portfolio.
Your goal is to outperform QQQ and SPY through disciplined, rules-based trading.
${contextBlock}
CURRENT PORTFOLIO STATE:
${JSON.stringify(portfolioState, null, 2)}

CANDIDATE STOCK DATA:
Symbol: ${stockData.symbol}
Current Price: $${stockData.price}
RSI (14): ${stockData.rsi}
50-day MA: $${stockData.ma50}
Price vs MA50: ${stockData.priceVsMa50}%
Volume today: ${stockData.volume}
Average volume: ${stockData.avgVolume}
Volume ratio: ${stockData.volumeRatio}x
News sentiment: ${stockData.sentiment}
Sector: ${stockData.sector}
Already holding this sector: ${stockData.sectorConflict}

SIGNALS MET: ${stockData.signalsMet}/5
${stockData.signalDetails}

SYSTEM RULES:
- Max positions: ${systemRules.maxPositions}
- Stop loss: ${systemRules.stopLossPct * 100}%
- Take profit: ${systemRules.takeProfitPct * 100}%
- Available capital: $${portfolioState.availableCapital}
- Weekly budget remaining: $${portfolioState.weeklyBudgetRemaining}

Evaluate this candidate and return ONLY a valid JSON object with no markdown:
{
  "decision": "buy" or "watchlist" or "pass",
  "confidence": 1-10,
  "position_size": <dollar amount or null>,
  "stop_loss_price": <price or null>,
  "take_profit_price": <price or null>,
  "reasoning": "<2-3 sentence plain English explanation that references the market regime and composite score>",
  "risk_flags": ["<any concerns>"],
  "regime_influenced": true or false
}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse(response.content[0].text);
}

export async function claudeDailySummary(portfolioSnapshot, tradesToday, vsSpyQqq) {
  const tradeLines = tradesToday
    .map(t => `- ${t.side.toUpperCase()} ${t.symbol} @ $${t.price}`)
    .join('\n');

  const prompt = `Write a 3-sentence daily trading summary for a passive investor.
Be direct, clear, and include the key numbers.

Portfolio value: $${portfolioSnapshot.total_value}
Today's P&L: ${portfolioSnapshot.daily_pnl_pct}%
vs SPY today: ${vsSpyQqq.spy >= 0 ? '+' : ''}${vsSpyQqq.spy}%
vs QQQ today: ${vsSpyQqq.qqq >= 0 ? '+' : ''}${vsSpyQqq.qqq}%
Trades today: ${tradesToday.length}
${tradeLines}

Return ONLY valid JSON with no markdown:
{ "summary": "...", "next_week_plan": "..." }`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse(response.content[0].text);
}
