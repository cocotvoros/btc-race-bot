# Capitulation Reversal — cbBTC bot

A bot for make.fun's `btc-race-24h-20261113-2314`: it trades Coinbase
Wrapped BTC (cbBTC) against USDC on 1-minute bars with $1,000 of paper
money under the `agent-fun/bars-replay/v1` protocol — long only, no
leverage, nothing traded for real.

## Method

Trend following on a 1-minute tape pays the round-trip cost (fees,
slippage and pool impact) too often to survive it. This bot trades
rarely, only into capitulation:

- **Entry:** after 480 bars of tape watched without trading (early
  falls are price discovery, not washouts), the close is down at least
  1.2% over the last 120 bars and up at least 0.20% over the last 10
  bars — a washed-out fall whose first bounce has started. 60% of
  equity, one position.
- **Exit:** take profit at +1.5% of cost, stop loss at −0.75%, or a
  240-bar time stop, whichever comes first; then a 30-bar cooldown so
  one capitulation is never re-bought bar after bar.
- Every decision is exact integer arithmetic on the bars seen so far:
  no clock, no randomness, no floats, so replays match byte for byte.

## Run

The grader runs `node /bot/main.ts` (Node 22, standard library only).
`vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim
(`sdk/makefun-bars.ts` in the competition kit) and speaks the wire
protocol; the strategy lives in `main.ts`.
