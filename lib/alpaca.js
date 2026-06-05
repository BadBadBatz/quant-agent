import Alpaca from '@alpacahq/alpaca-trade-api';

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: process.env.ALPACA_BASE_URL?.includes('paper') ?? true,
  usePolygon: false,
});

export async function getAccount() {
  return await alpaca.getAccount();
}

export async function getPositions() {
  return await alpaca.getPositions();
}

export async function getPosition(symbol) {
  try {
    return await alpaca.getPosition(symbol);
  } catch {
    return null;
  }
}

export async function placeBracketOrder({ symbol, notional, stopLossPct, takeProfitPct }) {
  const quotes = await alpaca.getLatestQuote(symbol);
  const price = quotes.AskPrice || quotes.ap;

  if (!price || price <= 0) throw new Error(`Could not get quote for ${symbol}`);

  const qty = Math.floor(notional / price);
  if (qty < 1) throw new Error(`Insufficient capital for 1 share of ${symbol} @ $${price}`);

  const stopPrice = parseFloat((price * (1 - stopLossPct)).toFixed(2));
  const takeProfitPrice = parseFloat((price * (1 + takeProfitPct)).toFixed(2));

  return await alpaca.createOrder({
    symbol,
    qty,
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    order_class: 'bracket',
    stop_loss: { stop_price: stopPrice },
    take_profit: { limit_price: takeProfitPrice },
  });
}

export async function sellPosition(symbol, qty) {
  return await alpaca.createOrder({
    symbol,
    qty,
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
  });
}

export async function getOrders({ status = 'all', limit = 50 } = {}) {
  return await alpaca.getOrders({ status, limit });
}

export async function getOrder(id) {
  return await alpaca.getOrder(id);
}

// Poll an order until it fills (or terminates). Market orders during market
// hours fill in well under a second; this just guards the race so we log the
// real fill price/qty instead of the stale pre-trade close.
export async function waitForFill(orderId, { attempts = 6, delayMs = 1000 } = {}) {
  let order = await alpaca.getOrder(orderId);
  const terminal = new Set(['filled', 'canceled', 'rejected', 'expired']);
  for (let i = 0; i < attempts && !terminal.has(order.status); i++) {
    await new Promise(r => setTimeout(r, delayMs));
    order = await alpaca.getOrder(orderId);
  }
  return order;
}

export async function getBars(symbol, timeframe = '1Day', limit = 60) {
  // Without an explicit start date the API returns only the latest bar.
  // Multiply limit by 2 to cover weekends + holidays when requesting daily bars.
  const msPerDay = 24 * 60 * 60 * 1000;
  const calendarDays = timeframe === '1Day' ? limit * 2 : limit;
  const start = new Date(Date.now() - calendarDays * msPerDay)
    .toISOString()
    .split('T')[0];

  const bars = alpaca.getBarsV2(symbol, { timeframe, limit, start });

  const result = [];
  for await (const bar of bars) result.push(bar);
  return result;
}

export async function getBarsBetween(symbol, { timeframe = '1Day', start, end, limit = 1000 } = {}) {
  const params = { timeframe, limit };
  if (start) params.start = start instanceof Date ? start.toISOString() : start;
  if (end) params.end = end instanceof Date ? end.toISOString() : end;

  const bars = alpaca.getBarsV2(symbol, params);
  const result = [];
  for await (const bar of bars) result.push(bar);
  return result;
}

export async function getLatestQuote(symbol) {
  return await alpaca.getLatestQuote(symbol);
}

export async function isClock() {
  return await alpaca.getClock();
}
