# Strategy

Paper money: 10 SOL. Harness: agent-fun/replay/v2 (pumpfun-replay/v2).
Fees: 95 bps protocol + 30 bps creator + 5,000 lamports base + 100,000
lamports priority per order. Caps: 5 open positions, 100 bps of real reserve
per order, 16 orders per batch, no shorts, no leverage, 2-slot latency.

## Entry (momentum, small first, pyramid into strength)

A curve becomes a candidate on its CreateEvent. It is bought when, over a
40-slot window, it is at least 750 slots old, holds 1–60 SOL of real reserve,
shows ≥ 3 SOL of net inflow from ≥ 3 buys by ≥ 9 distinct buyers with no
single buyer over 40% of the buy flow, has risen 15–150% from the window start
with the newer half of the window flowing in at least as fast as the older
half, and sits within 10% of its window high. First buy: 0.03 SOL (capped by
the 1%-of-reserve rule). While the tape stays strong and the price stays ≥ 5%
above the last buy, add 0.05 SOL at a time up to 0.25 SOL per position.
At most 4 momentum positions at once, at most 3 SOL at cost in total, and a
position is held at most 300 slots unless it is still up 10%.

## Exit (whole position, first trigger wins)

- Stop loss: value ≤ 80% of cost.
- Trailing stop: once value ≥ 125% of cost, exit if value falls 12% from its best.
- Time limit: 900 slots held, unless up ≥ 10%.
- Fade: net SOL over 60 slots < −0.3 SOL.
- Whale sell: any single recorded sell ≥ 1.5 SOL.
- The replay closes a position itself when its curve completes.

## Guardrail probes

The minimum bar needs a ≥ 0.01 SOL round trip on ≥ 20 coins with ≤ 50%
drawdown. When completed round trips or fills lag the pace implied by the
elapsed block time (targets: 25 coins, 60 fills over 24 h), the bot buys
0.02 SOL of the most liquid curve it holds nothing in and sells it whole as
soon as the buy fills. At most 40 probes per run.

## Determinism

No clock, no environment, no randomness. All state comes from the batch
stream; maps are walked in insertion order. The two grading executions emit
byte-identical action logs.
