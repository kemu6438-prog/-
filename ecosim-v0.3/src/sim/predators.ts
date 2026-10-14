// 肉食獣（Phase 2 の捕食者）。SoA（Float32Array）・GC なし。草食獣と同じ構造の簡易 FSM：
// 狩り / 水飲み / 休息 / 求愛 / うろつき。獲物との接触で捕獲し、獲物の死体がエネルギーになる。

import { CFG, DAYS_PER_YEAR } from './config';
import { Rng } from './rng';
import { World, WORLD } from './world';
import type { Herbivores } from './agents';
import { maxEnergy, type Traits } from './agents';

export const PST = { WANDER: 0, HUNT: 1, DRINK: 2, REST: 3, MATE: 4, DIGEST: 5 } as const;
export const PST_NAMES = ['うろつき', '狩り', '水飲み', '休息', '求愛', '消化'];

export interface PredDeaths {
  starve: number;
  thirst: number;
  old: number;
  drown: number;
  disease: number;
  impact: number;
}
export function emptyPredDeaths(): PredDeaths {
  return { starve: 0, thirst: 0, old: 0, drown: 0, disease: 0, impact: 0 };
}

const MAX = CFG.CARN_MAX * 2; // 余裕を持った確保（上限は CARN_MAX で制御）
const MATURE_DAYS = 2 * DAYS_PER_YEAR;
const MAX_AGE_DAYS = 10 * DAYS_PER_YEAR;
const WATER_DRINK_PER_DAY = 150;

export class Carnivores {
  readonly x = new Float32Array(MAX);
  readonly z = new Float32Array(MAX);
  readonly heading = new Float32Array(MAX);
  readonly energy = new Float32Array(MAX);
  readonly health = new Float32Array(MAX);
  readonly hydration = new Float32Array(MAX);
  readonly age = new Float32Array(MAX);
  readonly mass = new Float32Array(MAX);
  readonly leg = new Float32Array(MAX);
  readonly fur = new Float32Array(MAX);
  readonly hue = new Float32Array(MAX);
  readonly cooldown = new Float32Array(MAX);
  readonly wander = new Float32Array(MAX);
  readonly speed = new Float32Array(MAX);
  readonly target = new Int32Array(MAX).fill(-1);
  /** この年齢（日）まで消化中（狩りをしない） */
  readonly digestUntil = new Float32Array(MAX);
  /** 直近の探索で数えた、視界内の獲物の数 */
  readonly preyNear = new Float32Array(MAX);
  readonly mate = new Int32Array(MAX).fill(-1);
  readonly alive = new Uint8Array(MAX);
  readonly state = new Uint8Array(MAX);

  highWater = 0;
  count = 0;
  births = 0;
  kills = 0;
  deaths: PredDeaths = emptyPredDeaths();

  private free = new Int32Array(MAX);
  private freeTop = 0;
  private stepNo = 0;
  private tgx = 0;
  private tgz = 0;

  constructor(
    private readonly world: World,
    private readonly rng: Rng,
  ) {
    for (let i = MAX - 1; i >= 0; i--) this.free[this.freeTop++] = i;
  }

  spawn(x: number, z: number, t: Traits, energyAbs: number, ageDays: number): number {
    if (this.freeTop === 0 || this.count >= CFG.CARN_MAX) return -1;
    const i = this.free[--this.freeTop]!;
    this.alive[i] = 1;
    this.x[i] = x;
    this.z[i] = z;
    this.heading[i] = this.rng.float() * Math.PI * 2;
    this.mass[i] = t.mass;
    this.leg[i] = t.leg;
    this.fur[i] = t.fur;
    this.hue[i] = t.hue;
    this.energy[i] = energyAbs;
    this.health[i] = 100;
    this.hydration[i] = 100;
    this.age[i] = ageDays;
    this.cooldown[i] = 0;
    this.wander[i] = this.rng.range(0, 3);
    this.speed[i] = 0;
    this.target[i] = -1;
    this.mate[i] = -1;
    this.digestUntil[i] = 0;
    this.state[i] = PST.WANDER;
    this.count++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    return i;
  }

  /** 外部（疫病・隕石）による死。 */
  killExternal(i: number, cause: keyof PredDeaths): void {
    if (this.alive[i]) this.kill(i, cause);
  }

  private kill(i: number, cause: keyof PredDeaths): void {
    this.alive[i] = 0;
    this.count--;
    this.free[this.freeTop++] = i;
    this.deaths[cause]++;
    const c = this.world.cellIndexOf(this.x[i]!, this.z[i]!);
    this.world.soilN[c] = Math.min(1, this.world.soilN[c]! + 0.02);
  }

  /** 1 step 進める。prey は草食獣、predation は捕食圧（0..PREDATION_MAX）。 */
  step(dt: number, prey: Herbivores, predation: number): void {
    this.stepNo++;
    const hw = this.highWater;
    for (let i = 0; i < hw; i++) {
      if (this.alive[i]) this.updateOne(i, dt, prey, predation);
    }
  }

  private canMate(j: number): boolean {
    return (
      this.alive[j] === 1 &&
      this.age[j]! >= MATURE_DAYS &&
      this.cooldown[j]! <= 0 &&
      this.energy[j]! / maxEnergy(this.mass[j]!) >= 0.6
    );
  }

  /** 最も近い獲物（草食獣）を視界内から探す。 */
  private findPrey(i: number, prey: Herbivores): number {
    const x = this.x[i]!;
    const z = this.z[i]!;
    const r = CFG.CARN_SIGHT;
    let best = -1;
    let bestD = r * r;
    let n = 0;
    const hw = prey.highWater;
    for (let j = 0; j < hw; j++) {
      if (!prey.alive[j]) continue;
      const dx = prey.x[j]! - x;
      if (dx > r || dx < -r) continue;
      const dz = prey.z[j]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      n++;
      if (d2 < bestD) {
        bestD = d2;
        best = j;
      }
    }
    this.preyNear[i] = n;
    return best;
  }

  private findMate(i: number): number {
    const x = this.x[i]!;
    const z = this.z[i]!;
    let best = -1;
    const r = CFG.CARN_MATE_SIGHT;
    let bestD = r * r;
    for (let j = 0; j < this.highWater; j++) {
      if (j === i || !this.canMate(j)) continue;
      const dx = this.x[j]! - x;
      const dz = this.z[j]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = j;
      }
    }
    return best;
  }

  /** 水の方向へ（距離場の勾配で）目標を決める。 */
  private toWater(x: number, z: number): boolean {
    const w = this.world;
    let best = w.distWater[w.cellIndexOf(x, z)]!;
    let found = false;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const px = x + Math.sin(a) * 8;
      const pz = z + Math.cos(a) * 8;
      if (px < 0 || pz < 0 || px >= WORLD || pz >= WORLD) continue;
      if (w.heightAt(px, pz) < w.sea) continue;
      const v = w.distWater[w.cellIndexOf(px, pz)]!;
      if (v < best - 1e-4) {
        best = v;
        this.tgx = px;
        this.tgz = pz;
        found = true;
      }
    }
    return found;
  }

  private wanderDrift(i: number, dt: number): void {
    this.wander[i] = this.wander[i]! - dt;
    if (this.wander[i]! <= 0) {
      this.heading[i] = this.heading[i]! + this.rng.gauss() * 1.0;
      this.wander[i] = this.rng.range(3, 8);
    }
  }

  private updateOne(i: number, dt: number, prey: Herbivores, predation: number): void {
    const w = this.world;
    const rng = this.rng;
    const dayFrac = dt / CFG.DAY_SECONDS;

    this.age[i] = this.age[i]! + dayFrac;
    this.cooldown[i] = Math.max(0, this.cooldown[i]! - dayFrac);
    if (this.age[i]! >= MAX_AGE_DAYS) {
      this.kill(i, 'old');
      return;
    }

    const mass = this.mass[i]!;
    const leg = this.leg[i]!;
    const x = this.x[i]!;
    const z = this.z[i]!;
    const h = w.heightAt(x, z);
    const depth = w.sea - h;
    const swimming = depth > CFG.SWIM_DEPTH_TRIGGER * leg;
    const mE = maxEnergy(mass);
    const mature = this.age[i]! >= MATURE_DAYS;
    const e = this.energy[i]! / mE;
    let hydration = this.hydration[i]! - 12 * dayFrac;

    let cost = CFG.BMR_COEF * Math.pow(mass, 0.75) * CFG.ENERGY_SCALE * CFG.CARN_BMR_MUL * dayFrac;

    // 状態決定
    let st: number = this.state[i]!;
    if (this.age[i]! < this.digestUntil[i]!) st = PST.DIGEST; // 消化中は狩りをしない（捕食圧の自己制限）
    else if (this.state[i] === PST.DRINK && hydration < 75) st = PST.DRINK; // 水飲みはヒステリシスで完遂
    else if (hydration < 30) st = PST.DRINK;
    else if (e < 0.3) st = PST.HUNT; // 極度の飢えは休息より優先（飢餓死の防止）
    else if (this.health[i]! < 40) st = PST.REST;
    else if (e < 0.6) st = PST.HUNT;
    else if (mature && this.cooldown[i]! <= 0 && this.health[i]! >= 60) st = PST.MATE;
    else st = PST.WANDER; // 満腹（e >= 0.6）なら狩りをやめる

    let hasTarget = false;
    let spd = 0;
    let intake = 0;

    switch (st) {
      case PST.DRINK: {
        if (w.distWater[w.cellIndexOf(x, z)]! <= 2) {
          hydration = Math.min(100, hydration + WATER_DRINK_PER_DAY * dayFrac);
        } else if (this.toWater(x, z)) {
          hasTarget = true;
          spd = 0.8;
        } else {
          this.wanderDrift(i, dt);
          spd = 0.5;
        }
        break;
      }
      case PST.HUNT: {
        // 獲物の再探索（5 step ごと）
        let t = this.target[i]!;
        if (t < 0 || !prey.alive[t] || (this.stepNo + i) % 5 === 0) {
          t = this.findPrey(i, prey);
          this.target[i] = t;
        }
        if (t >= 0) {
          const dx = prey.x[t]! - x;
          const dz = prey.z[t]! - z;
          const d2 = dx * dx + dz * dz;
          this.tgx = prey.x[t]!;
          this.tgz = prey.z[t]!;
          hasTarget = true;
          spd = 1.0;
          if (d2 < CFG.CARN_ATTACK_RANGE * CFG.CARN_ATTACK_RANGE) {
            // 攻撃：獲物の俊敏さで捕獲率が変わる（速い獲物は逃げられやすい）
            const herbSpeed = prey.speed[t]!;
            const evade = herbSpeed > CFG.BASE_MAX_SPEED * 0.8 ? 0.5 : 1.0;
            // 獲物が少ないほど捕獲が難しい（避難効果）
            const density = this.preyNear[i]! / (this.preyNear[i]! + CFG.CARN_PREY_HALF);
            if (rng.float() < CFG.CARN_CATCH_CHANCE * predation * evade * density) {
              intake = CFG.CARN_MEAT_SHARE * maxEnergy(prey.mass[t]!);
              prey.killExternal(t, 'predated');
              this.kills++;
              this.target[i] = -1;
              this.digestUntil[i] = this.age[i]! + CFG.CARN_HANDLING_DAYS;
              spd = 0;
            }
          }
        } else {
          this.wanderDrift(i, dt);
          spd = 0.6;
        }
        break;
      }
      case PST.REST:
      case PST.DIGEST: {
        this.health[i] = Math.min(100, this.health[i]! + 3 * dayFrac);
        spd = 0;
        break;
      }
      case PST.MATE: {
        let p = this.mate[i]!;
        if (p >= 0 && !this.canMate(p)) p = -1;
        if (p < 0 && (this.stepNo + i) % 10 === 0) p = this.findMate(i);
        this.mate[i] = p;
        if (p < 0) {
          this.wanderDrift(i, dt);
          spd = 0.5;
        } else {
          const px = this.x[p]!;
          const pz = this.z[p]!;
          const dx = px - x;
          const dz = pz - z;
          if (dx * dx + dz * dz < 9) {
            this.breed(i, p);
            spd = 0;
          } else {
            this.tgx = px;
            this.tgz = pz;
            hasTarget = true;
            spd = 0.9;
          }
        }
        break;
      }
      default: {
        this.wanderDrift(i, dt);
        spd = 0.5;
      }
    }
    if (st !== PST.MATE) this.mate[i] = -1;
    this.state[i] = st;

    let hd = this.heading[i]!;
    if (hasTarget) hd = turnToward(hd, Math.atan2(this.tgx - x, this.tgz - z), CFG.BASE_TURN_RATE * dt);
    if (swimming && st !== PST.DRINK && !hasTarget) {
      hd = turnToward(hd, Math.atan2(WORLD / 2 - x, WORLD / 2 - z), CFG.BASE_TURN_RATE * dt);
    }

    const maxSp = CFG.BASE_MAX_SPEED * CFG.CARN_SPEED_MUL * Math.sqrt(leg / 1.0) * (mature ? 1 : CFG.JUVENILE_SPEED_MUL);
    let v = spd * maxSp;
    const sx = Math.sin(hd);
    const sz = Math.cos(hd);
    const slope = Math.abs(w.heightAt(x + sx * 2, z + sz * 2) - h) / 2;
    if (slope > CFG.SLOPE_MAX) v *= Math.max(0.1, 1 - CFG.SLOPE_PENALTY_COEF * (slope - CFG.SLOPE_MAX));
    if (swimming) v *= 0.4;

    let nx = x + sx * v * dt;
    let nz = z + sz * v * dt;
    if (nx < 2 || nx > WORLD - 2 || nz < 2 || nz > WORLD - 2) {
      hd = Math.atan2(WORLD / 2 - x, WORLD / 2 - z);
      nx = Math.min(WORLD - 2, Math.max(2, nx));
      nz = Math.min(WORLD - 2, Math.max(2, nz));
      v *= 0.5;
    }
    if (w.heightAt(nx, nz) < w.sea - CFG.DEEP_WATER) {
      hd += (rng.float() - 0.5) * 2.5;
      nx = x;
      nz = z;
      v = 0;
    }
    this.x[i] = nx;
    this.z[i] = nz;
    this.heading[i] = hd;
    this.speed[i] = v;

    cost += (CFG.MOVE_COST_COEF * CFG.MOVE_COST_SCALE * CFG.CARN_MOVE_MUL * mass * v * v) / 1000 * dt * CFG.ENERGY_SCALE * (swimming ? CFG.SWIM_COST_MUL : 1);
    this.energy[i] = this.energy[i]! + intake - cost;

    let health = this.health[i]!;
    let cause: keyof PredDeaths | null = null;
    if (this.energy[i]! <= 0) {
      this.energy[i] = 0;
      health -= CFG.STARVE_DAMAGE * dt;
      cause = 'starve';
    } else if (this.energy[i]! > mE * 0.5 && hydration > 50 && health < 100) {
      health = Math.min(100, health + 1.5 * dayFrac);
    }
    if (hydration <= 0) {
      hydration = 0;
      health -= 3 * dt;
      cause = cause ?? 'thirst';
    }
    if (depth > CFG.DROWN_DEPTH) {
      health -= CFG.DROWN_DAMAGE * dt;
      cause = cause ?? 'drown';
    }
    this.hydration[i] = Math.min(100, hydration);
    this.health[i] = health;
    if (health <= 0 && cause) this.kill(i, cause);
  }

  private breed(a: number, b: number): void {
    const share = 0.3 * this.energy[a]!;
    if (this.energy[a]! - share < 0.2 * maxEnergy(this.mass[a]!)) return;
    this.energy[a] = this.energy[a]! - share;
    const rng = this.rng;
    const sigma = CFG.MUTATION_SIGMA * (this.count < 8 ? 2 : 1);
    const mass = clampf(Math.sqrt(this.mass[a]! * this.mass[b]!) * Math.exp(rng.gauss() * sigma), 20, 200);
    const leg = clampf(Math.sqrt(this.leg[a]! * this.leg[b]!) * Math.exp(rng.gauss() * sigma), 0.3, 2.5);
    const fur = clampf((this.fur[a]! + this.fur[b]!) / 2 + rng.gauss() * sigma * 0.5, 0, 1);
    let hue = (this.hue[a]! + this.hue[b]!) / 2 + rng.gauss() * 0.02;
    hue -= Math.floor(hue);
    if (this.spawn(this.x[a]! + rng.gauss(), this.z[a]! + rng.gauss(), { mass, leg, fur, hue }, share, 0) >= 0) this.births++;
    this.cooldown[a] = CFG.CARN_MATE_COOLDOWN_DAYS;
    this.cooldown[b] = CFG.CARN_MATE_COOLDOWN_DAYS;
  }

  meanStats(): { mass: number; leg: number; fur: number; energy: number } {
    let m = 0;
    let l = 0;
    let f = 0;
    let e = 0;
    let n = 0;
    for (let i = 0; i < this.highWater; i++) {
      if (!this.alive[i]) continue;
      m += this.mass[i]!;
      l += this.leg[i]!;
      f += this.fur[i]!;
      e += this.energy[i]! / maxEnergy(this.mass[i]!);
      n++;
    }
    if (n === 0) return { mass: 0, leg: 0, fur: 0, energy: 0 };
    return { mass: m / n, leg: l / n, fur: f / n, energy: e / n };
  }
}

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function turnToward(cur: number, want: number, maxStep: number): number {
  const d = wrapPi(want - cur);
  if (Math.abs(d) <= maxStep) return want;
  return cur + Math.sign(d) * maxStep;
}
