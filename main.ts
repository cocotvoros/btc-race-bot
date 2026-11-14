// Capitulation-reversal bot for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// Idea: on a 1-minute tape a plain trend follower pays the round-trip cost
// (4 bps fee + 2 bps slippage a side, plus pool impact) over and over and
// bleeds. This bot trades rarely and only into washed-out moves:
//
//   Entry (all comparisons in exact integer arithmetic on raw closes):
//     - the bot first watches 400 bars without trading: a capitulation is
//       only readable against a full stretch of tape, and the falls in the
//       opening hours of a window are still price discovery, not washouts
//       (locally, entries taken in the early tape turned the same signal
//       negative — one extra losing trade there),
//     - the close has fallen at least 1.8% over the last 240 bars
//       (close * 1000 <= close[-240] * 982), and
//     - the close has bounced at least +0.20% over the last 10 bars
//       (close * 1000 >= close[-10] * 1002) — sellers are exhausted and the
//       first buyers are back, but the price is still deep in the hole.
//   Stake: the full equity in one position (the caps allow exactly one);
//   at this pool's depth a $1,000 fill moves its own price only ~7 bps.
//   Exit (the first that fires, latched until the position is flat):
//     - take profit: position value >= 102.5% of its cost (+2.5%),
//     - stop loss:   position value <= 99.0% of its cost (-1.0%),
//     - time stop:   360 bars held — a bounce that has not paid by then is
//       not coming, and the capital is freed.
//   After an exit the bot waits 30 bars before it may enter again, so one
//   capitulation cannot be re-bought bar after bar.
//
// Orders cap their slippage at 100 bps past the close they were decided on,
// like the kit's own EMA baseline: a fill far through the book is refused
// and retried on the next bar instead of taken at any price. Everything is
// a pure function of the bars seen so far — no clock, no randomness, no
// floats in the decisions — so two runs over the same window agree byte
// for byte.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** Bars of tape watched before the first entry may fire. */
const CONTEXT_BARS = 400;
/** Bars of decline the entry looks back over. */
const DROP_LOOKBACK = 240;
/** The drop, in tenths of a percent kept: close <= close[-240] * 982/1000 is a fall of 1.8% or more. */
const DROP_KEEP_NUM = 982n;
/** Bars of bounce the entry looks back over. */
const BOUNCE_LOOKBACK = 10;
/** The bounce: close >= close[-10] * 1002/1000 is a rise of 0.20% or more. */
const BOUNCE_NUM = 1002n;
const RATIO_DEN = 1000n;
/** Stake: the full equity on the single allowed position. */
const STAKE_BPS = 10_000n;
/** Take profit: value >= cost * 10250/10000 (+2.5%). */
const TAKE_PROFIT_NUM = 10_250n;
/** Stop loss: value <= cost * 9900/10000 (-1.0%). */
const STOP_LOSS_NUM = 9_900n;
const EXIT_DEN = 10_000n;
/** Time stop: bars a position may be held before it is sold whatever it shows. */
const MAX_HOLD_BARS = 360;
/** Bars to stay flat after an exit before entering again. */
const COOLDOWN_BARS = 30;
/** Slippage cap on every order, past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** Every close seen so far, in batch order (raw integer prices). */
const closes: bigint[] = [];
/** Batches answered since the position was first seen on the account. */
let heldBars = 0;
/** True from the batch an exit fires until the account is flat again. */
let exitLatched = false;
/** Batches since the account last went flat after holding; starts past the cooldown. */
let flatBars = COOLDOWN_BARS + 1;
/** True while a position was on the account at the previous batch. */
let wasHolding = false;

/** The entry test on the closes seen so far. */
function capitulationTurn(): boolean {
  const n = closes.length;
  if (n <= CONTEXT_BARS || n <= DROP_LOOKBACK) return false;
  const now = closes[n - 1];
  const dropped = now * RATIO_DEN <= closes[n - 1 - DROP_LOOKBACK] * DROP_KEEP_NUM;
  if (!dropped) return false;
  const bounced = now * RATIO_DEN >= closes[n - 1 - BOUNCE_LOOKBACK] * BOUNCE_NUM;
  return bounced;
}

/** Whether a held position exits on this batch: take profit, stop loss or the time stop. */
function exitDue(state: BarsState, symbol: string): boolean {
  const held = state.positions.get(symbol);
  if (held === undefined) return false;
  const value = state.value(symbol, held.qty);
  if (value * EXIT_DEN >= held.cost * TAKE_PROFIT_NUM) return true;
  if (value * EXIT_DEN <= held.cost * STOP_LOSS_NUM) return true;
  return heldBars >= MAX_HOLD_BARS;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) closes.push(BigInt(bar.c));
    const symbol = state.hello.symbols[0].symbol;
    const held = state.positions.get(symbol);

    if (held !== undefined) {
      heldBars = wasHolding ? heldBars + 1 : 0;
      wasHolding = true;
      flatBars = 0;
    } else {
      if (wasHolding) exitLatched = false;
      wasHolding = false;
      heldBars = 0;
      flatBars += 1;
    }
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    if (held !== undefined) {
      if (exitLatched || exitDue(state, symbol)) {
        exitLatched = true;
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    if (flatBars <= COOLDOWN_BARS) return orders;
    if (!capitulationTurn()) return orders;

    const { caps, fees } = state.hello;
    let stake = (state.equity * STAKE_BPS) / BPS;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    if (byWeight < stake) stake = byWeight;
    if (state.cash < stake) stake = state.cash;
    if (stake === 0n || stake < BigInt(fees.min_notional_quote_units)) return orders;
    orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
