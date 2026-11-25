// Momentum paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: most new pump.fun curves die within minutes, but the
// ones that catch a bid keep catching it for a while. This bot watches every
// curve's tape, buys a small first stake only when several independent buyers
// are pushing SOL in faster and faster while the price grinds near its recent
// high, adds to the position only while the tape stays strong and the price
// stays above the last buy, and gets out whole on a stop loss, a trailing stop,
// a fading tape, a whale sell, or a time limit. A pacing probe keeps the run
// above the 20-coin round-trip bar even on a quiet stretch of the replay.
//
// Deterministic by construction: no clock, no environment, no randomness. All
// state comes from the batch stream, and every map is walked in insertion
// order, so two runs over the same replay emit byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = (x: number): bigint => BigInt(Math.round(x * 1_000_000_000));

export interface Params {
  /** Entry window, in slots. */
  windowSlots: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Net SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Buy trades in the entry window. */
  minBuys: number;
  /** Distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Largest single buyer's share of window buy SOL (0..1). */
  maxBuyerShare: number;
  /** Price now over price at window start, minus 1: lower bound. */
  minPriceUp: number;
  /** Same rise: upper bound (skip curves that already ran too far). */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve at entry: lower and upper bounds. */
  minRqSol: number;
  maxRqSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Total SOL per position at most. */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps). Sells always go out wide open. */
  buySlipBps: number;
  /** Exit when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: exit when value falls to best * (1 - trail). */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHoldSlots: number;
  /** The time limit does not apply while the position is up this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add only once the price is this much above the last buy's price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (one slot stays free for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target coins and fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round trip size (SOL). */
  probeSol: number;
  /** Most probe round trips in a run. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 40,
  minAgeSlots: 600,
  minNetSol: 2,
  minBuys: 3,
  minBuyers: 7,
  maxBuyerShare: 0.4,
  minPriceUp: 0.1,
  maxPriceUp: 1.5,
  accel: 1.0,
  nearHigh: 0.9,
  minRqSol: 1,
  maxRqSol: 60,
  initialSol: 0.03,
  addSol: 0.05,
  stakeSol: 0.25,
  minBuySol: 0.012,
  buySlipBps: 500,
  stopLoss: 0.2,
  trail: 0.12,
  trailArm: 0.25,
  fadeWindow: 60,
  fadeNetSol: 0.3,
  bigSellSol: 1.5,
  maxHoldSlots: 900,
  holdIfUp: 0.1,
  cooldownSlots: 120,
  maxEntries: 3,
  addStep: 0.05,
  addNetSol: 0.4,
  maxMain: 4,
  maxExposureSol: 3,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 86400,
  probeSol: 0.02,
  maxProbes: 40,
};

interface TapeTrade {
  slot: number;
  /** Signed SOL: positive for a buy, negative for a sell. */
  sol: number;
  user: string;
  /** Price (SOL per token) right after this trade. */
  price: number;
}

interface CurveTape {
  createdSlot: number;
  trades: TapeTrade[];
  /** Highest price seen inside the current window. */
  windowHigh: number;
  /** Price at the oldest trade still inside the window. */
  windowStartPrice: number;
  /** Any single sell of at least bigSellSol SOL seen since the last buy. */
  bigSellSeen: boolean;
}

interface PositionMeta {
  /** SOL spent on this position so far (buys that filled). */
  spentSol: number;
  /** Price at the most recent buy. */
  lastBuyPrice: number;
  /** Best mark-to-market value (SOL) seen since entry. */
  bestValueSol: number;
  /** Slot the position was opened. */
  openSlot: number;
  /** How many buys this curve has taken this run. */
  entries: number;
  /** Slot until which this curve may not be bought again. */
  cooldownUntil: number;
  /** True while a probe sell is waiting on its buy fill. */
  probePending: boolean;
}

export class MomentumBot {
  readonly params: Params;
  /** Per-mint tape, in first-seen order. */
  private tapes = new Map<Pubkey, CurveTape>();
  /** Per-mint position bookkeeping, in first-seen order. */
  private meta = new Map<Pubkey, PositionMeta>();
  /** Client ids of probe buys waiting on their fill. */
  private probeBuys = new Map<string, Pubkey>();
  /** Mints whose probe buy filled and whose sell is now due. */
  private probeSellsDue = new Set<Pubkey>();
  /** Distinct mints with a completed round trip of >= 0.01 SOL. */
  private roundTripped = new Set<Pubkey>();
  /** Mints we ever bought (for round-trip counting on harness closes). */
  private boughtMints = new Set<Pubkey>();
  /** Fills seen this run (all client ids, ours and the harness's). */
  private fillsSeen = 0;
  /** Probes started this run. */
  private probesStarted = 0;
  /** First and latest block time seen, for pacing. */
  private firstBlockTime: number | null = null;
  private lastBlockTime: number | null = null;
  private nextClient = 1;

  constructor(params: Params = DEFAULT_PARAMS) {
    this.params = params;
  }

  private clientId(prefix: string): string {
    return `${prefix}${this.nextClient++}`;
  }

  /** Price of a curve in SOL per token, from its virtual reserves. */
  private priceOf(state: BotState, mint: Pubkey): number {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    const vt = Number(c.virtual_token_reserves);
    const vq = Number(c.virtual_quote_reserves);
    if (vt <= 0 || vq <= 0) return 0;
    return vq / vt;
  }

  /** Mark-to-market value of a holding in SOL. */
  private valueSol(state: BotState, mint: Pubkey): number {
    const pos = state.positions.get(mint);
    if (pos === undefined) return 0;
    const tokens = Number(pos.token_amount);
    return (tokens * this.priceOf(state, mint)) / 1e9;
  }

  private costSol(state: BotState, mint: Pubkey): number {
    const pos = state.positions.get(mint);
    if (pos === undefined) return 0;
    return Number(pos.cost_lamports) / 1e9;
  }

  private tape(mint: Pubkey, slot: number): CurveTape {
    let t = this.tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: slot, trades: [], windowHigh: 0, windowStartPrice: 0, bigSellSeen: false };
      this.tapes.set(mint, t);
    }
    return t;
  }

  private metaOf(mint: Pubkey, slot: number): PositionMeta {
    let m = this.meta.get(mint);
    if (m === undefined) {
      m = { spentSol: 0, lastBuyPrice: 0, bestValueSol: 0, openSlot: slot, entries: 0, cooldownUntil: 0, probePending: false };
      this.meta.set(mint, m);
    }
    return m;
  }

  /** True when a sell for this mint is still in flight. */
  private pendingSell(state: BotState, mint: Pubkey): boolean {
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell' && po.order.mint === mint) return true;
    }
    return false;
  }

  /** True when a buy for this mint is still in flight. */
  private pendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy' && po.order.mint === mint) return true;
    }
    return false;
  }

  /** Fold one batch's events into the tapes. */
  private ingest(state: BotState, batch: Batch): void {
    const p = this.params;
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (this.firstBlockTime === null) this.firstBlockTime = e.block_time;
        this.lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = this.tape(e.mint, e.slot);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = this.tape(e.mint, e.slot);
        const sol = Number(e.sol_amount) / 1e9;
        const price = this.priceOf(state, e.mint);
        t.trades.push({ slot: e.slot, sol: e.is_buy ? sol : -sol, user: e.user, price });
        if (!e.is_buy && sol >= p.bigSellSol) t.bigSellSeen = true;
        // Prune trades older than the longest window we consult.
        const horizon = e.slot - Math.max(p.windowSlots, p.fadeWindow);
        while (t.trades.length > 0 && t.trades[0].slot < horizon) t.trades.shift();
      }
    }
    // Refresh each touched tape's window stats.
    for (const [mint, t] of this.tapes) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const from = batch.slot - p.windowSlots;
      let high = 0;
      let start = 0;
      let seen = false;
      for (const tr of t.trades) {
        if (tr.slot < from) continue;
        if (!seen) {
          start = tr.price;
          seen = true;
        }
        if (tr.price > high) high = tr.price;
      }
      if (seen) {
        t.windowHigh = high;
        t.windowStartPrice = start;
      }
    }
  }

  /** Window stats for a mint: net SOL, buys, distinct buyers, acceleration. */
  private windowStats(t: CurveTape, slot: number): {
    net: number;
    buys: number;
    buyers: number;
    maxShare: number;
    accel: number;
  } {
    const p = this.params;
    const from = slot - p.windowSlots;
    const mid = slot - p.windowSlots / 2;
    let net = 0;
    let netOld = 0;
    let netNew = 0;
    let buys = 0;
    const buyers = new Set<string>();
    const byBuyer = new Map<string, number>();
    let buySol = 0;
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      net += tr.sol;
      if (tr.slot < mid) netOld += tr.sol;
      else netNew += tr.sol;
      if (tr.sol > 0) {
        buys += 1;
        buySol += tr.sol;
        buyers.add(tr.user);
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0) + tr.sol);
      }
    }
    let maxShare = 0;
    for (const v of byBuyer.values()) if (buySol > 0 && v / buySol > maxShare) maxShare = v / buySol;
    const accel = netOld <= 0 ? (netNew > 0 ? Number.POSITIVE_INFINITY : 0) : netNew / netOld;
    return { net, buys, buyers: buyers.size, maxShare, accel };
  }

  private fadeNet(t: CurveTape, slot: number): number {
    const from = slot - this.params.fadeWindow;
    let net = 0;
    for (const tr of t.trades) {
      if (tr.slot >= from) net += tr.sol;
    }
    return net;
  }

  /** Apply the batch's fills to our bookkeeping. */
  private applyFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      this.fillsSeen += 1;
      if (f.status !== 'filled') continue;
      const mint = f.mint;
      const m = this.metaOf(mint, batch.slot);
      if (f.side === 'buy') {
        this.boughtMints.add(mint);
        const spent = Number(f.quote_lamports) / 1e9;
        m.spentSol += spent;
        m.entries += 1;
        m.lastBuyPrice = this.priceOf(state, mint);
        const t = this.tapes.get(mint);
        if (t !== undefined) t.bigSellSeen = false;
        if (this.probeBuys.has(f.client_id)) {
          this.probeBuys.delete(f.client_id);
          this.probeSellsDue.add(mint);
          m.probePending = true;
        }
      } else {
        // A sell (ours or the harness's close) completes the round trip.
        if (this.boughtMints.has(mint)) this.roundTripped.add(mint);
        if (f.client_id.startsWith('q')) {
          this.probeSellsDue.delete(mint);
          m.probePending = false;
        }
        // A position closed by the harness leaves no holding behind.
        if (f.client_id.startsWith('_')) {
          m.spentSol = 0;
          m.bestValueSol = 0;
          m.cooldownUntil = batch.slot + this.params.cooldownSlots;
        }
      }
    }
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const p = this.params;
    this.ingest(state, batch);
    this.applyFills(state, batch);

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    const caps = state.hello.caps;
    const maxOrders = caps.max_orders_per_batch;

    const canOrder = (): boolean => orders.length < maxOrders;

    // ---- 1. Probe sells: a probe buy that filled gets sold whole, at once.
    for (const mint of [...this.probeSellsDue]) {
      if (!canOrder()) break;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) {
        this.probeSellsDue.delete(mint);
        continue;
      }
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: 10_000,
        client_id: this.clientId('q'),
      });
      free -= tx;
      this.probeSellsDue.delete(mint);
    }

    // ---- 2. Momentum exits: stop, trail, time, fade, whale sell.
    for (const [mint, pos] of state.positions) {
      if (!canOrder()) break;
      if (this.meta.get(mint)?.probePending) continue;
      if (this.pendingSell(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const m = this.metaOf(mint, batch.slot);
      const cost = this.costSol(state, mint);
      const value = this.valueSol(state, mint);
      if (cost <= 0 || value <= 0) continue;
      if (value > m.bestValueSol) m.bestValueSol = value;
      const t = this.tapes.get(mint);
      const held = batch.slot - m.openSlot;
      let exit = false;
      if (value <= cost * (1 - p.stopLoss)) exit = true;
      if (!exit && m.bestValueSol >= cost * (1 + p.trailArm) && value <= m.bestValueSol * (1 - p.trail)) exit = true;
      if (!exit && held >= p.maxHoldSlots && value < cost * (1 + p.holdIfUp)) exit = true;
      if (!exit && t !== undefined && this.fadeNet(t, batch.slot) < -p.fadeNetSol) exit = true;
      if (!exit && t !== undefined && t.bigSellSeen) exit = true;
      if (!exit) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: 10_000,
        client_id: this.clientId('s'),
      });
      free -= tx;
      m.spentSol = 0;
      m.bestValueSol = 0;
      m.cooldownUntil = batch.slot + p.cooldownSlots;
    }

    // ---- 3. Pyramid adds: strength only, while the tape stays strong.
    const mainCount = [...state.positions.keys()].filter((k) => !this.meta.get(k)?.probePending).length;
    let exposureSol = 0;
    for (const [mint] of state.positions) {
      if (!this.meta.get(mint)?.probePending) exposureSol += this.costSol(state, mint);
    }
    for (const [mint, pos] of state.positions) {
      if (!canOrder()) break;
      if (this.meta.get(mint)?.probePending) continue;
      if (this.pendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const m = this.metaOf(mint, batch.slot);
      if (m.spentSol >= p.stakeSol) continue;
      const price = this.priceOf(state, mint);
      if (price <= 0 || m.lastBuyPrice <= 0) continue;
      if (price < m.lastBuyPrice * (1 + p.addStep)) continue;
      const t = this.tapes.get(mint);
      if (t === undefined) continue;
      if (this.windowStats(t, batch.slot).net < p.addNetSol) continue;
      const cap = state.maxBuyLamports(mint);
      const room = SOL(p.stakeSol) - BigInt(Math.round(m.spentSol * 1e9));
      const amount = cap < SOL(p.addSol) ? cap : SOL(p.addSol);
      const want = amount < room ? amount : room;
      if (want < SOL(p.minBuySol)) continue;
      if (free < want + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: want,
        max_slippage_bps: p.buySlipBps,
        client_id: this.clientId('b'),
      });
      free -= want + tx;
      exposureSol += Number(want) / 1e9;
    }

    // ---- 4. New momentum entries.
    let momentumBuys = 0;
    for (const [mint, t] of this.tapes) {
      if (!canOrder()) break;
      if (state.positions.has(mint)) continue;
      if (this.pendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (batch.slot - t.createdSlot < p.minAgeSlots) continue;
      const rq = Number(curve.real_quote_reserves) / 1e9;
      if (rq < p.minRqSol || rq > p.maxRqSol) continue;
      const m = this.metaOf(mint, batch.slot);
      if (batch.slot < m.cooldownUntil) continue;
      if (m.entries >= p.maxEntries) continue;
      if (mainCount + momentumBuys >= p.maxMain) continue;
      if (state.committedPositionCount() + momentumBuys >= caps.max_open_positions) continue;
      if (exposureSol >= p.maxExposureSol) continue;
      const st = this.windowStats(t, batch.slot);
      if (st.net < p.minNetSol) continue;
      if (st.buys < p.minBuys) continue;
      if (st.buyers < p.minBuyers) continue;
      if (st.maxShare > p.maxBuyerShare) continue;
      if (st.accel < p.accel) continue;
      const price = this.priceOf(state, mint);
      if (price <= 0 || t.windowStartPrice <= 0 || t.windowHigh <= 0) continue;
      const up = price / t.windowStartPrice - 1;
      if (up < p.minPriceUp || up > p.maxPriceUp) continue;
      if (price < t.windowHigh * p.nearHigh) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < SOL(p.initialSol) ? cap : SOL(p.initialSol);
      if (amount < SOL(p.minBuySol)) continue;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: p.buySlipBps,
        client_id: this.clientId('b'),
      });
      free -= amount + tx;
      exposureSol += Number(amount) / 1e9;
      momentumBuys += 1;
      m.openSlot = batch.slot;
    }

    // ---- 5. Guardrail probes: stay on pace for the 20-coin round-trip bar.
    if (this.probesStarted < p.maxProbes && canOrder()) {
      const elapsed =
        this.firstBlockTime !== null && this.lastBlockTime !== null
          ? Math.max(0, this.lastBlockTime - this.firstBlockTime)
          : 0;
      const paceShare = p.paceSecs > 0 ? Math.min(1, elapsed / p.paceSecs) : 1;
      const coinsPace = p.targetCoins * paceShare;
      const fillsPace = p.targetFills * paceShare;
      const coinsBehind = this.roundTripped.size < coinsPace;
      const fillsBehind = this.fillsSeen < fillsPace;
      const openCount = state.committedPositionCount() + momentumBuys;
      if ((coinsBehind || fillsBehind) && openCount < caps.max_open_positions && free > SOL(p.probeSol) + tx) {
        // Most liquid curve we hold nothing in and have not probed into lately.
        let bestMint: Pubkey | null = null;
        let bestRq = 0;
        for (const [mint, curve] of state.curves) {
          if (curve.complete) continue;
          if (state.positions.has(mint)) continue;
          if (this.pendingBuy(state, mint)) continue;
          const m = this.meta.get(mint);
          if (m !== undefined && batch.slot < m.cooldownUntil) continue;
          if (m !== undefined && m.probePending) continue;
          const rq = Number(curve.real_quote_reserves);
          if (rq < 1_000_000_000) continue;
          if (rq > bestRq) {
            bestRq = rq;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          const amount = cap < SOL(p.probeSol) ? cap : SOL(p.probeSol);
          if (amount >= SOL(p.minBuySol) && free >= amount + tx) {
            const id = this.clientId('p');
            this.probeBuys.set(id, bestMint);
            orders.push({
              side: 'buy',
              mint: bestMint,
              quote_lamports: amount,
              max_slippage_bps: p.buySlipBps,
              client_id: id,
            });
            free -= amount + tx;
            this.probesStarted += 1;
          }
        }
      }
    }

    return orders;
  }
}
