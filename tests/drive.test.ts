import { describe, expect, it } from "vitest";
import { Driver, LIMIT_KMH } from "../src/world/drive";
import { analyzeNodes, polylineLength, type RoadLine } from "../src/world/roadData";

/** 格子状の道（間隔 200m、幅員区分 3） */
function grid(n: number, step: number, rank = 3): RoadLine[] {
  const lines: RoadLine[] = [];
  let id = 1;
  const mk = (x0: number, z0: number, x1: number, z1: number) => {
    const pts = new Float32Array([x0, z0, x1, z1]);
    lines.push({ id: id++, pts, rank, ctg: 2, startShift: -1, endShift: -1, startNode: -1, endNode: -1, startCut: false, endCut: false, length: polylineLength(pts) });
  };
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      mk(i * step, j * step, i * step, (j + 1) * step); // 縦
      mk(j * step, i * step, (j + 1) * step, i * step); // 横
    }
  }
  return lines;
}

function distToLines(lines: RoadLine[], x: number, z: number) {
  let best = Infinity;
  for (const l of lines) {
    const p = l.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1];
      const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (p[i] + dx * t), z - (p[i + 1] + dz * t)));
    }
  }
  return best;
}

describe("自動運転の動き", () => {
  const lines = grid(4, 200);
  const nodes = analyzeNodes(lines);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  it("走り続けて、道から外れず、飛ばず、制限速度を守り、信号で止まる", () => {
    const d = new Driver(lines, nodes, rand);
    expect(d.start(210, 100)).toBe(true);
    let t = 0;
    let moved = 0;
    let prev = { x: d.pose.x, z: d.pose.z };
    let maxJump = 0;
    let maxSpeed = 0;
    let waited = 0;
    let maxOff = 0;
    for (let i = 0; i < 12000; i++) {
      d.update(0.05, t);
      t += 0.05;
      const j = Math.hypot(d.pose.x - prev.x, d.pose.z - prev.z);
      maxJump = Math.max(maxJump, j);
      moved += j;
      prev = { x: d.pose.x, z: d.pose.z };
      maxSpeed = Math.max(maxSpeed, d.speed);
      if (d.waiting) waited += 0.05;
      maxOff = Math.max(maxOff, distToLines(lines, d.pose.x, d.pose.z));
      expect(Number.isFinite(d.pose.x) && Number.isFinite(d.pose.z) && Number.isFinite(d.yaw)).toBe(true);
    }
    expect(moved).toBeGreaterThan(2000); // 10 分で 2km 以上
    expect(maxJump).toBeLessThan(1.0); // 1 コマ 0.05 秒で 20m/秒未満
    expect(maxSpeed).toBeLessThanOrEqual(LIMIT_KMH[3] / 3.6 + 0.01);
    expect(waited).toBeGreaterThan(5); // 信号待ちをした
    expect(maxOff).toBeLessThan(12); // 道の近くを走っている
  });

  it("赤のあいだは停止線で止まり、動かない", () => {
    const d = new Driver(lines, nodes, rand);
    d.start(210, 100);
    let t = 0;
    let stopped: { x: number; z: number; t: number } | null = null;
    for (let i = 0; i < 6000 && !stopped; i++) {
      d.update(0.05, t);
      t += 0.05;
      if (d.waiting && d.speed === 0) stopped = { x: d.pose.x, z: d.pose.z, t };
    }
    expect(stopped).not.toBeNull();
    // そのあとしばらく（数秒）は動かない
    for (let i = 0; i < 20; i++) {
      d.update(0.05, t);
      t += 0.05;
      if (!d.waiting) break;
      expect(Math.hypot(d.pose.x - stopped!.x, d.pose.z - stopped!.z)).toBeLessThan(0.2);
    }
  });

  it("向きは進む向きと同じで、左側の車線を走り、向きがとびとびに変わらない", () => {
    const d = new Driver(lines, nodes, rand);
    d.start(210, 100);
    let t = 0;
    let prev = { x: d.pose.x, z: d.pose.z };
    let prevYaw = d.yaw;
    let maxYawStep = 0;
    let bad = 0, checked = 0, leftBad = 0, leftChecked = 0;
    for (let i = 0; i < 12000; i++) {
      d.update(0.05, t);
      t += 0.05;
      const mx = d.pose.x - prev.x, mz = d.pose.z - prev.z;
      const ml = Math.hypot(mx, mz);
      if (ml > 0.02) {
        checked++;
        if ((mx * d.pose.hx + mz * d.pose.hz) / ml < 0.9) bad++; // 進む向きと車の向きが違う
        // カメラの向き（yaw）も進む向きと合っている
        const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
        if ((mx * fx + mz * fz) / ml < 0.5) bad++;
      }
      let dy = d.yaw - prevYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      maxYawStep = Math.max(maxYawStep, Math.abs(dy));
      prevYaw = d.yaw;
      prev = { x: d.pose.x, z: d.pose.z };
      // 交差点から離れた直線の上では、道の中心より左（進行方向の左）にいる
      const gx = Math.round(d.pose.x / 200) * 200, gz = Math.round(d.pose.z / 200) * 200;
      const onVert = Math.abs(d.pose.x - gx) < 6 && Math.abs(d.pose.z - gz) > 40 && Math.abs(d.pose.z - gz) < 160;
      const onHorz = Math.abs(d.pose.z - gz) < 6 && Math.abs(d.pose.x - gx) > 40 && Math.abs(d.pose.x - gx) < 160;
      if ((onVert || onHorz) && Math.abs(d.pose.hx) + Math.abs(d.pose.hz) > 0.99 && d.speed > 1) {
        leftChecked++;
        const lat = onVert ? (d.pose.x - gx) : (d.pose.z - gz); // 道の中心からの位置（東・南が正）
        const leftSign = onVert ? d.pose.hz * -1 * -1 : -d.pose.hx; // 左 = (hz, -hx)
        // 左ベクトルの x 成分（縦の道）/ z 成分（横の道）
        const leftComp = onVert ? d.pose.hz : -d.pose.hx;
        void leftSign;
        if (lat * leftComp <= 0) leftBad++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toBe(0);
    expect(leftChecked).toBeGreaterThan(200);
    expect(leftBad).toBe(0);
    expect(maxYawStep).toBeLessThan(0.08); // 0.05 秒で 4.6 度未満（急にぐんと回らない）
  });

  it("行き止まりでは、なめらかにＵターンして戻る", () => {
    const one: RoadLine[] = grid(1, 160).slice(0, 1); // 160m の 1 本道
    const d = new Driver(one, analyzeNodes(one), rand);
    expect(d.start(0, 80)).toBe(true);
    let t = 0;
    let prev = { x: d.pose.x, z: d.pose.z };
    let prevYaw = d.yaw;
    let maxJump = 0, maxYawStep = 0;
    let turned = false;
    const startHz = d.pose.hz;
    for (let i = 0; i < 6000; i++) {
      d.update(0.05, t);
      t += 0.05;
      maxJump = Math.max(maxJump, Math.hypot(d.pose.x - prev.x, d.pose.z - prev.z));
      let dy = d.yaw - prevYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      maxYawStep = Math.max(maxYawStep, Math.abs(dy));
      prevYaw = d.yaw;
      prev = { x: d.pose.x, z: d.pose.z };
      if (d.pose.hz * startHz < -0.9) turned = true;
    }
    expect(turned).toBe(true);
    expect(maxJump).toBeLessThan(1.0);
    expect(maxYawStep).toBeLessThan(0.1);
  });
});
