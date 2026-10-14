// シミュレーション本体（DOM / Three.js 非依存）。Worker からも Node（headless）からも使う。

import { CFG, DAY_STEPS, DAYS_PER_YEAR, STEP_DT } from './config';
import { Herbivores, ST_NAMES, emptyDeaths, maxEnergy, type Controller, type Traits } from './agents';
import { GENOME_LEN, LOCUS } from './genome';
import { IN, OUT } from './brain';
import { speciesTreeLines } from './species';
import { Carnivores, emptyPredDeaths } from './predators';
import { Rng } from './rng';
import { World } from './world';
import type { DayRecord, EventKind, Selected, SpeciesRow, Status } from './protocol';
import { STRIDE } from './protocol';

const SEASON_NAMES = ['冬', '春', '夏', '秋'];

/** 期限付きの気候効果（寒波・熱波・干ばつ・豪雨・隕石の粉塵）。 */
interface ClimateEffect {
  kind: string;
  until: number; // この day 未満で有効
  temp: number;
  rain: number;
}

export interface Settings {
  temp: number; // 気温補正 [℃]
  rain: number; // 降雨倍率
  season: number; // 季節振幅 [℃]
  predation: number; // 捕食圧（捕獲確率の倍率）
}

export class Simulation {
  readonly seed: number;
  readonly world: World;
  readonly rng: Rng;
  readonly herbs: Herbivores;
  readonly carn: Carnivores;

  /** 総 step 数（1 step = STEP_TICKS tick） */
  stepTotal = 0;
  /** 経過日数（0 始まり） */
  day = 0;
  extinct = false;
  settings: Settings = { temp: 0, rain: 1, season: CFG.SEASONAL_AMPLITUDE as number, predation: 1 };
  private effects: ClimateEffect[] = [];
  /** Worker→UI へ未送信の日次記録・イベント */
  pendingDays: DayRecord[] = [];
  pendingEvents: string[] = [];
  /** 全期間の日次記録（headless 集計・グラフ用） */
  history: DayRecord[] = [];
  private warnedLow = false;
  private carnWarned = false;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.world = new World(seed);
    this.herbs = new Herbivores(this.world, this.rng);
    this.carn = new Carnivores(this.world, this.rng);
    this.herbs.onEvent = (m) => this.event(m);
    this.spawnStarters();
    // 始祖種（最初の草食獣の遺伝子を基準にする）
    const first = this.firstHerb();
    if (first >= 0) {
      const p = this.herbs.pheno[first]!;
      this.herbs.registry.createRoot(this.herbs.genome, first * GENOME_LEN, 0, p.mass, p.fur);
    }
    this.applyClimate();
    this.event(`世界を生成しました（シード ${seed}）。草食獣 ${this.herbs.count} 匹・肉食獣 ${this.carn.count} 匹を放ちました`);
  }

  get doy(): number {
    return this.day % DAYS_PER_YEAR;
  }
  get year(): number {
    return Math.floor(this.day / DAYS_PER_YEAR) + 1;
  }
  get season(): number {
    return Math.floor(this.doy / CFG.DAYS_PER_SEASON);
  }

  private firstHerb(): number {
    for (let i = 0; i < this.herbs.highWater; i++) if (this.herbs.alive[i]) return i;
    return -1;
  }

  /** 判断方式（'brain' か 'fsm'）と学習の有無を切り替える。 */
  setMode(controller: Controller, learning: boolean): void {
    this.herbs.controller = controller;
    this.herbs.learning = learning;
    this.event(`草食獣の行動：${controller === 'brain' ? '脳（ニューラルネット）' : '有限状態機械（比較用）'}・学習 ${learning ? 'ON' : 'OFF'}`);
  }

  private event(msg: string): void {
    this.pendingEvents.push(msg);
  }

  private spawnStarters(): void {
    let placed = 0;
    let tries = 0;
    const margin = 20;
    const size = CFG.WORLD_SIZE_M;
    while (placed < CFG.START_HERBIVORES && tries < 200000) {
      tries++;
      const x = this.rng.range(margin, size - margin);
      const z = this.rng.range(margin, size - margin);
      const c = this.world.cellIndexOf(x, z);
      if (this.world.cap[c]! < 50 || this.world.cellH[c]! < this.world.sea + 1) continue;
      if (this.spawnNear(x, z, CFG.PRESET_HERB, 0.7 * maxEnergy(CFG.PRESET_HERB.mass), 60 + this.rng.float() * 300)) placed++;
    }
    let cp = 0;
    tries = 0;
    while (cp < CFG.START_CARNIVORES && tries < 200000) {
      tries++;
      const x = this.rng.range(margin, size - margin);
      const z = this.rng.range(margin, size - margin);
      const c = this.world.cellIndexOf(x, z);
      if (this.world.cellH[c]! < this.world.sea + 1) continue;
      if (this.spawnPredator(x, z, CFG.PRESET_CARN, 0.7 * maxEnergy(CFG.PRESET_CARN.mass), 400 + this.rng.float() * 400)) cp++;
    }
  }

  /** 指定位置に草食獣を置く（陸地に限る）。 */
  spawnNear(x: number, z: number, t: Traits, energyAbs: number, ageDays: number): boolean {
    const jit = this.jitter(t);
    const px = x + this.rng.gauss() * 1.0;
    const pz = z + this.rng.gauss() * 1.0;
    if (this.world.heightAt(px, pz) < this.world.sea + 0.5) return false;
    return this.herbs.spawn(px, pz, jit, energyAbs, ageDays) >= 0;
  }

  /** 指定位置に肉食獣を置く（陸地に限る）。 */
  spawnPredator(x: number, z: number, t: Traits, energyAbs: number, ageDays: number): boolean {
    const jit = this.jitter(t);
    if (this.world.heightAt(x, z) < this.world.sea + 0.5) return false;
    return this.carn.spawn(x, z, jit, energyAbs, ageDays) >= 0;
  }

  private jitter(t: Traits): Traits {
    return {
      mass: t.mass * Math.exp(this.rng.gauss() * 0.05),
      leg: t.leg * Math.exp(this.rng.gauss() * 0.05),
      fur: Math.min(1, Math.max(0, t.fur + this.rng.gauss() * 0.03)),
      hue: (t.hue + this.rng.gauss() * 0.02 + 1) % 1,
    };
  }

  /** 1 step 進める。 */
  step(): void {
    if (this.extinct) return;
    if (this.stepTotal > 0 && this.stepTotal % DAY_STEPS === 0) this.beginDay();
    this.herbs.dayNow = this.day;
    this.herbs.setClock((this.stepTotal % DAY_STEPS) / DAY_STEPS, this.doy);
    this.herbs.step(STEP_DT, this.carn);
    this.carn.step(STEP_DT, this.herbs, this.settings.predation);
    this.stepTotal++;
    if (this.carn.count === 0 && !this.carnWarned) {
      this.carnWarned = true;
      this.event(`肉食獣が絶滅しました（${this.year}年目・${SEASON_NAMES[this.season]}）`);
    }
    if (this.herbs.count === 0) {
      this.extinct = true;
      this.event(`全滅しました（${this.year}年目・${SEASON_NAMES[this.season]}）。原因は統計パネルを参照`);
    }
  }

  private beginDay(): void {
    const rec = this.recordDay();
    this.day++;
    this.expireEffects();
    this.applyClimate();
    this.world.daily(this.doy);
    if (this.doy % CFG.DAYS_PER_SEASON === 0) {
      const dead = rec.starve + rec.thirst + rec.old + rec.heat + rec.drown + rec.predated + rec.disease + rec.impact;
      this.event(
        `第${this.year}年 ${SEASON_NAMES[this.season]}：草食獣 ${this.herbs.count} 匹・肉食獣 ${this.carn.count} 匹（直近の季節で出生 ${rec.births}・死亡 ${dead}）`,
      );
    }
    if (!this.warnedLow && this.herbs.count < CFG.MIN_POP_WARNING && this.herbs.count > 0) {
      this.warnedLow = true;
      this.event(`⚠ 草食獣が ${this.herbs.count} 匹まで減少（絶滅危惧）`);
    }
    if (this.herbs.count >= CFG.MIN_POP_WARNING) this.warnedLow = false;
  }

  private recordDay(): DayRecord {
    const h = this.herbs;
    const c = this.carn;
    const s = h.meanStats();
    const rec: DayRecord = {
      day: this.day,
      year: this.year,
      pop: h.count,
      predators: c.count,
      species: this.herbs.registry.count,
      meanMass: s.mass,
      meanLeg: s.leg,
      meanFur: s.fur,
      meanEnergy: s.energy,
      grassRatio: this.world.meanGrassRatio(),
      births: h.births,
      starve: h.deaths.starve,
      thirst: h.deaths.thirst,
      old: h.deaths.old,
      heat: h.deaths.heat,
      drown: h.deaths.drown,
      predated: h.deaths.predated,
      disease: h.deaths.disease + c.deaths.disease,
      impact: h.deaths.impact + c.deaths.impact,
      carnDeaths: c.deaths.starve + c.deaths.thirst + c.deaths.old + c.deaths.drown,
    };
    this.history.push(rec);
    this.pendingDays.push(rec);
    h.births = 0;
    h.deaths = emptyDeaths();
    c.births = 0;
    c.deaths = emptyPredDeaths();
    return rec;
  }

  private expireEffects(): void {
    this.effects = this.effects.filter((e) => e.until > this.day);
  }

  /** スライダーとイベント効果を合成して、世界の気候パラメータに反映する。 */
  private applyClimate(): void {
    let t = this.settings.temp;
    let r = this.settings.rain;
    for (const e of this.effects) {
      t += e.temp;
      r *= e.rain;
    }
    this.world.tempOffset = t;
    this.world.rainMul = r;
    this.world.seasonAmp = this.settings.season;
  }

  setSettings(s: Settings): void {
    this.settings = {
      temp: clamp(s.temp, CFG.CLIM_TEMP_MIN, CFG.CLIM_TEMP_MAX),
      rain: clamp(s.rain, CFG.CLIM_RAIN_MIN, CFG.CLIM_RAIN_MAX),
      season: clamp(s.season, CFG.CLIM_SEASON_MIN, CFG.CLIM_SEASON_MAX),
      predation: clamp(s.predation, 0, CFG.PREDATION_MAX),
    };
    this.applyClimate();
  }

  /** 山火事（プレイヤーの介入）。 */
  burn(x: number, z: number, r: number): void {
    const n = this.world.burn(x, z, r);
    this.event(`🔥 山火事（半径 ${r.toFixed(0)}m）：草が ${n} セル焼けました`);
  }

  /** 草食獣・肉食獣を放つ（プレイヤーの介入）。 */
  release(x: number, z: number, n: number, kind: 'herb' | 'carn' = 'herb'): void {
    let placed = 0;
    for (let k = 0; k < n * 4 && placed < n; k++) {
      const px = x + this.rng.gauss() * 6;
      const pz = z + this.rng.gauss() * 6;
      const ok =
        kind === 'herb'
          ? this.spawnNear(px, pz, CFG.PRESET_HERB, 0.7 * maxEnergy(CFG.PRESET_HERB.mass), 60 + this.rng.float() * 200)
          : this.spawnPredator(px, pz, CFG.PRESET_CARN, 0.7 * maxEnergy(CFG.PRESET_CARN.mass), 400 + this.rng.float() * 200);
      if (ok) placed++;
    }
    this.event(`${kind === 'herb' ? '草食獣' : '肉食獣'}を ${placed} 匹放しました`);
  }

  /** 気候イベント（プレイヤーが起こす）。 */
  triggerEvent(kind: EventKind, x: number, z: number): void {
    const d = this.day;
    switch (kind) {
      case 'cold':
        this.effects.push({ kind, until: d + CFG.EVT_COLD_DAYS, temp: CFG.EVT_COLD_TEMP, rain: 1 });
        this.event(`❄ 寒波：${CFG.EVT_COLD_DAYS} 日間、気温が ${-CFG.EVT_COLD_TEMP}℃ 下がります`);
        break;
      case 'heat':
        this.effects.push({ kind, until: d + CFG.EVT_HEAT_DAYS, temp: CFG.EVT_HEAT_TEMP, rain: 1 });
        this.event(`☀ 熱波：${CFG.EVT_HEAT_DAYS} 日間、気温が ${CFG.EVT_HEAT_TEMP}℃ 上がります`);
        break;
      case 'drought':
        this.effects.push({ kind, until: d + CFG.EVT_DROUGHT_DAYS, temp: 0, rain: CFG.EVT_DROUGHT_RAIN });
        this.event(`🏜 干ばつ：${CFG.EVT_DROUGHT_DAYS} 日間、降雨が激減します`);
        break;
      case 'flood':
        this.effects.push({ kind, until: d + CFG.EVT_FLOOD_DAYS, temp: 0, rain: CFG.EVT_FLOOD_RAIN });
        this.event(`🌧 豪雨：${CFG.EVT_FLOOD_DAYS} 日間、降雨が増えます`);
        break;
      case 'meteor': {
        const r = CFG.EVT_METEOR_RADIUS;
        const grassLost = this.world.clearGrass(x, z, r);
        let killed = 0;
        const h = this.herbs;
        for (let i = 0; i < h.highWater; i++) {
          if (!h.alive[i]) continue;
          if (Math.hypot(h.x[i]! - x, h.z[i]! - z) <= r) {
            h.killExternal(i, 'impact');
            killed++;
          }
        }
        const c = this.carn;
        for (let i = 0; i < c.highWater; i++) {
          if (!c.alive[i]) continue;
          if (Math.hypot(c.x[i]! - x, c.z[i]! - z) <= r) {
            c.killExternal(i, 'impact');
          }
        }
        this.effects.push({ kind, until: d + CFG.EVT_METEOR_DAYS, temp: CFG.EVT_METEOR_COOL, rain: 0.8 });
        this.event(`☄ 隕石：半径 ${r}m を直撃。草 ${grassLost} セルが焼失、草食獣 ${killed} 匹が死亡。粉塵で ${CFG.EVT_METEOR_DAYS} 日寒冷化`);
        this.applyClimate();
        break;
      }
      case 'plague': {
        let hk = 0;
        let ck = 0;
        const h = this.herbs;
        for (let i = 0; i < h.highWater; i++) {
          if (h.alive[i] && this.rng.float() < CFG.EVT_PLAGUE_KILL) {
            h.killExternal(i, 'disease');
            hk++;
          }
        }
        const c = this.carn;
        for (let i = 0; i < c.highWater; i++) {
          if (c.alive[i] && this.rng.float() < CFG.EVT_PLAGUE_CARN_KILL) {
            c.killExternal(i, 'disease');
            ck++;
          }
        }
        this.event(`☣ 疫病：草食獣 ${hk} 匹・肉食獣 ${ck} 匹が死亡`);
        break;
      }
    }
    this.applyClimate();
  }

  /** 描画用スナップショット。 */
  snapshot(selSlot: number, withGrass: boolean): {
    status: Status;
    ids: Int32Array;
    data: Float32Array;
    states: Uint8Array;
    pdata: Float32Array;
    pstates: Uint8Array;
    grassRatio: Float32Array | null;
    selected: Selected | null;
    species: SpeciesRow[] | null;
  } {
    const h = this.herbs;
    const n = h.count;
    const ids = new Int32Array(n);
    const data = new Float32Array(n * STRIDE);
    const states = new Uint8Array(n);
    let k = 0;
    const hw = h.highWater;
    for (let i = 0; i < hw; i++) {
      if (!h.alive[i]) continue;
      const x = h.x[i]!;
      const z = h.z[i]!;
      const mature = h.age[i]! >= CFG.MATURITY_YEARS * DAYS_PER_YEAR;
      const growth = mature ? 1 : CFG.JUVENILE_SIZE_MUL + (1 - CFG.JUVENILE_SIZE_MUL) * (h.age[i]! / (CFG.MATURITY_YEARS * DAYS_PER_YEAR));
      const sf = Math.cbrt(h.mass[i]! / 40) * growth;
      const o = k * STRIDE;
      data[o] = x;
      data[o + 1] = this.world.heightAt(x, z);
      data[o + 2] = z;
      data[o + 3] = h.heading[i]!;
      data[o + 4] = sf;
      data[o + 5] = h.leg[i]!;
      data[o + 6] = h.fur[i]!;
      data[o + 7] = h.hue[i]!;
      data[o + 8] = Math.min(1, h.energy[i]! / maxEnergy(h.mass[i]!));
      ids[k] = i;
      states[k] = h.state[i]!;
      k++;
    }

    // 肉食獣
    const c = this.carn;
    const pdata = new Float32Array(c.count * STRIDE);
    const pstates = new Uint8Array(c.count);
    let pk = 0;
    for (let i = 0; i < c.highWater; i++) {
      if (!c.alive[i]) continue;
      const x = c.x[i]!;
      const z = c.z[i]!;
      const mature = c.age[i]! >= 2 * DAYS_PER_YEAR;
      const growth = mature ? 1 : CFG.JUVENILE_SIZE_MUL + (1 - CFG.JUVENILE_SIZE_MUL) * (c.age[i]! / (2 * DAYS_PER_YEAR));
      const sf = Math.cbrt(c.mass[i]! / 55) * growth;
      const o = pk * STRIDE;
      pdata[o] = x;
      pdata[o + 1] = this.world.heightAt(x, z);
      pdata[o + 2] = z;
      pdata[o + 3] = c.heading[i]!;
      pdata[o + 4] = sf;
      pdata[o + 5] = c.leg[i]!;
      pdata[o + 6] = c.fur[i]!;
      pdata[o + 7] = c.hue[i]!;
      pdata[o + 8] = Math.min(1, c.energy[i]! / maxEnergy(c.mass[i]!));
      pstates[pk] = c.state[i]!;
      pk++;
    }

    let selected: Selected | null = null;
    if (selSlot >= 0 && selSlot < hw && h.alive[selSlot]) {
      const i = selSlot;
      const genes: Record<string, number> = {};
      const g = i * GENOME_LEN;
      for (const name of ['bodyLength', 'legLength', 'furDensity', 'brainSize', 'plasticity', 'startleReflex', 'metabolismRate', 'thermalTolerance', 'sociability']) {
        const li = LOCUS[name]!;
        genes[name] = (h.genome[g + li * 2]! + h.genome[g + li * 2 + 1]!) / 2;
      }
      const p = h.pheno[i]!;
      selected = {
        brainIn: Array.from(h.lastIn.subarray(i * IN, i * IN + IN)),
        brainOut: Array.from(h.lastOut.subarray(i * OUT, i * OUT + OUT)),
        activeH: h.activeH[i]!,
        species: h.registry.list[h.species[i]!]?.name ?? '',
        speciesId: h.species[i]!,
        genes,
        plasticity: p.plasticity,
        ageYears: h.age[i]! / 120,
        slot: i,
        mass: h.mass[i]!,
        leg: h.leg[i]!,
        fur: h.fur[i]!,
        hue: h.hue[i]!,
        energy: Math.min(1, h.energy[i]! / maxEnergy(h.mass[i]!)),
        health: h.health[i]!,
        hydration: h.hydration[i]!,
        age: h.age[i]!,
        state: ST_NAMES[h.state[i]!] ?? '',
        speed: h.speed[i]!,
      };
    }

    return {
      status: {
        day: this.day,
        year: this.year,
        doy: this.doy,
        season: this.season,
        pop: n,
        predators: c.count,
        extinct: this.extinct,
        seed: this.seed,
        speed: 0,
        tick: this.stepTotal * CFG.STEP_TICKS,
      },
      ids,
      data,
      states,
      pdata,
      pstates,
      grassRatio: withGrass ? this.world.grassRatio() : null,
      selected,
      species: withGrass ? this.speciesRows() : null,
    };
  }

  /** 系統の表示用（生存数つき）。 */
  speciesRows(): SpeciesRow[] {
    const counts = this.herbs.speciesCounts();
    return speciesTreeLines(this.herbs.registry.list).map((line) => ({
      depth: line.depth,
      text: line.text,
      alive: counts[line.id] ?? 0,
      id: line.id,
    }));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
