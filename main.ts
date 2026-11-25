// Momentum paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// Entrypoint, run by the grader as `node /bot/main.ts`. The strategy lives in
// strategy.ts; this file only wires it to the harness shim in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { MomentumBot } from './strategy.ts';

const bot = new MomentumBot();

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
