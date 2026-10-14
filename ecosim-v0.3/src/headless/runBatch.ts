// ヘッドレス実行：DOM なしで生態系を回し、個体群の推移を表示する（spec §4.2 / roadmap Phase 1 受入）。
// 使い方： npm run headless -- --years 100 --seeds 3

import { Simulation } from '../sim/sim';
import { DAY_STEPS, DAYS_PER_YEAR } from '../sim/config';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const years = arg('years', 10);
const seeds = arg('seeds', 1);
const baseSeed = arg('seed', 42);
const ctrlArg = process.argv.includes('--fsm') ? 'fsm' : 'brain';
const learnArg = !process.argv.includes('--nolearn');
const t0 = Date.now();

for (let s = 0; s < seeds; s++) {
  const seed = baseSeed + s;
  const sim = new Simulation(seed);
  sim.setMode(ctrlArg, learnArg);
  const totalSteps = years * DAYS_PER_YEAR * DAY_STEPS;
  let minPop = Infinity;
  let maxPop = 0;
  let carnMin = Infinity;
  let carnMax = 0;
  let extinctYear = -1;
  console.log(`--- seed ${seed} ---`);
  const landRatio = (() => {
    let land = 0;
    for (let k = 0; k < sim.world.cellH.length; k++) if (sim.world.cellH[k]! >= sim.world.sea) land++;
    return land / sim.world.cellH.length;
  })();
  console.log(`land ${(landRatio * 100).toFixed(0)}%  start pop ${sim.herbs.count}`);
  for (let st = 0; st < totalSteps && !sim.extinct; st++) {
    sim.step();
  }
  for (const r of sim.history) {
    minPop = Math.min(minPop, r.pop);
    maxPop = Math.max(maxPop, r.pop);
    carnMin = Math.min(carnMin, r.predators);
    carnMax = Math.max(carnMax, r.predators);
    if (r.pop === 0 && extinctYear < 0) extinctYear = r.year;
  }
  for (let y = 1; y <= Math.ceil(sim.history.length / DAYS_PER_YEAR); y++) {
    const slice = sim.history.filter((r) => r.year === y);
    if (slice.length === 0) continue;
    if (y % Math.max(1, Math.floor(years / 10)) !== 0 && y !== 1 && y !== years) continue;
    const last = slice[slice.length - 1]!;
    const avg = (f: (r: typeof last) => number) => slice.reduce((a, r) => a + f(r), 0) / slice.length;
    console.log(
      `Y${String(y).padStart(3)} pop=${String(last.pop).padStart(5)}  avgPop=${avg((r) => r.pop).toFixed(0).padStart(5)}  ` +
        `grass=${avg((r) => r.grassRatio).toFixed(2)}  mass=${avg((r) => r.meanMass).toFixed(1)}  leg=${avg((r) => r.meanLeg).toFixed(2)}  ` +
        `fur=${avg((r) => r.meanFur).toFixed(2)}  carn=${last.predators} cdeath=${slice.reduce((a, r) => a + r.carnDeaths, 0)} births=${slice.reduce((a, r) => a + r.births, 0)} predated=${slice.reduce((a, r) => a + r.predated, 0)}  starve=${slice.reduce((a, r) => a + r.starve, 0)} thirst=${slice.reduce((a, r) => a + r.thirst, 0)} old=${slice.reduce((a, r) => a + r.old, 0)} heat=${slice.reduce((a, r) => a + r.heat, 0)}`,
    );
  }
  console.log(`min pop=${minPop}  max pop=${maxPop}  carn min=${carnMin} max=${carnMax}  extinct=${sim.extinct ? `year ${extinctYear}` : 'no'}`);
}
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
