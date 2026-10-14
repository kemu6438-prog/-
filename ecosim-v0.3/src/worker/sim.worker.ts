// Simulation Worker：シミュレーションをメインスレッドから分離する（spec §4.2）。
// メインは毎フレーム 'frame' を送り、Worker は持ち時間内で step を進めてスナップショットを返す。

import { Simulation } from '../sim/sim';
import { CFG } from '../sim/config';
import type { Command, DayRecord, WorkerOut } from '../sim/protocol';

const ctx = self as unknown as {
  postMessage(msg: WorkerOut, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<Command>) => void) | null;
};

let sim: Simulation | null = null;
let speed = 1;
let pendingTicks = 0;
let selected = -1;
let frameNo = 0;
const GRASS_EVERY = 6; // 草の充足率マップは間引いて送る（帯域節約）
let outDays: DayRecord[] = [];

function postTerrain(): void {
  if (!sim) return;
  const w = sim.world;
  const vertH = w.vertH.slice();
  const biome = w.biome.slice();
  const grassRatio = w.grassRatio();
  ctx.postMessage({ type: 'terrain', vertH, biome, sea: w.sea, seed: w.seed, grassRatio }, [
    vertH.buffer,
    biome.buffer,
    grassRatio.buffer,
  ]);
}

function newWorld(seed: number): void {
  sim = new Simulation(seed);
  pendingTicks = 0;
  selected = -1;
  postTerrain();
}

function postSnapshot(withGrass: boolean): void {
  if (!sim) return;
  const snap = sim.snapshot(selected, withGrass);
  snap.status.speed = speed;
  const days = sim.pendingDays;
  const events = sim.pendingEvents;
  sim.pendingDays = [];
  sim.pendingEvents = [];
  outDays = days;
  const transfer: Transferable[] = [snap.ids.buffer, snap.data.buffer, snap.states.buffer, snap.pdata.buffer, snap.pstates.buffer];
  if (snap.grassRatio) transfer.push(snap.grassRatio.buffer);
  ctx.postMessage(
    {
      type: 'snapshot',
      status: snap.status,
      ids: snap.ids,
      data: snap.data,
      states: snap.states,
      pdata: snap.pdata,
      pstates: snap.pstates,
      grassRatio: snap.grassRatio,
      species: snap.species,
      days: outDays,
      events,
      selected: snap.selected,
    },
    transfer,
  );
}

ctx.onmessage = (e: MessageEvent<Command>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
    case 'reset':
      newWorld(m.seed);
      break;
    case 'speed':
      speed = m.value;
      break;
    case 'burn':
      sim?.burn(m.x, m.z, m.r);
      break;
    case 'spawn':
      sim?.release(m.x, m.z, m.n, m.kind);
      break;
    case 'mode':
      sim?.setMode(m.controller, m.learning);
      break;
    case 'event':
      sim?.triggerEvent(m.kind, m.x, m.z);
      break;
    case 'settings':
      sim?.setSettings({ temp: m.temp, rain: m.rain, season: m.season, predation: m.predation });
      break;
    case 'select':
      selected = m.slot;
      break;
    case 'frame': {
      if (!sim) break;
      frameNo++;
      if (!sim.extinct && speed > 0) {
        const dtS = Math.min(m.dtMs / 1000, 0.1);
        pendingTicks += speed * CFG.SIM_HZ * dtS;
        // 追いつけない時は間引く（spec §4.1：処理落ち）
        const cap = CFG.SIM_HZ * 2;
        if (pendingTicks > cap) pendingTicks = cap;
      }
      const t0 = performance.now();
      while (pendingTicks >= CFG.STEP_TICKS && performance.now() - t0 < 12) {
        sim.step();
        pendingTicks -= CFG.STEP_TICKS;
        if (sim.extinct) {
          pendingTicks = 0;
          break;
        }
      }
      postSnapshot(frameNo % GRASS_EVERY === 0);
      break;
    }
  }
};

