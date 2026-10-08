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
});
