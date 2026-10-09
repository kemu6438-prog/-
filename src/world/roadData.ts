// 道路データ（国土地理院の「ベクトルタイル」）を読み込んで、道路の線（中心線）に直す。
// 画面や three.js には依存しない（単体テストできる）。
// データの形式は GSI の experimental_bvmap（レイヤー "road"、ftCode 27xx = 道路中心線）。
//   rnkWidth: 幅員区分 0:3m未満 1:3〜5.5m 2:5.5〜13m 3:13〜19.5m 4:19.5m以上
//   rdCtg:    道路分類 0:国道 1:都道府県道 2:市区町村道 3:高速 …
//   lvOrder:  0 = 地面の高さ（高架などは 1 以上）
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

export const ZOOM = 16;
export const tileUrl = (z: number, x: number, y: number) =>
  `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${z}/${x}/${y}.pbf`;

export const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** 幅員区分ごとの、道路の幅（m）。区分の真ん中あたりの値 */
export const ROAD_WIDTH = [2.6, 4.4, 8.6, 15.5, 22];
/** 歩道の幅（m）。細い道には付けない */
export const SIDEWALK_WIDTH = [0, 0, 2.0, 3.2, 4.0];

export type RoadLine = {
  id: number;
  /** x, z, x, z …（画面の座標。x=東、z=南） */
  pts: Float32Array;
  rank: number;
  ctg: number;
  /** 線の両端が、他の道との交わり（3 本以上）なら、その交差点の中心から道の縁までの距離。交わりでなければ -1 */
  startShift: number;
  endShift: number;
  /** 線の両端が交差点に属していれば、その交差点の番号。属していなければ -1 */
  startNode: number;
  endNode: number;
  /** 両端がタイルの境目で切れているか（境目なら交差点と見なさない） */
  startCut: boolean;
  endCut: boolean;
  length: number;
};

export type RoadLayerLike = {
  length: number;
  extent: number;
  feature(i: number): {
    type: number;
    properties: Record<string, unknown>;
    loadGeometry(): { x: number; y: number }[][];
  };
};

/** タイルの 1 レイヤーから、地面の高さにある道路の線を取り出す */
export function parseRoadLayer(
  layer: RoadLayerLike,
  tx: number,
  ty: number,
  toXZ: (lon: number, lat: number) => [number, number],
  nextId: () => number,
  z = ZOOM,
): RoadLine[] {
  const out: RoadLine[] = [];
  const ext = layer.extent;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const p = f.properties as Record<string, number>;
    if (f.type !== 2) continue;
    if (Math.floor(Number(p.ftCode) / 100) !== 27) continue;
    if (Number(p.lvOrder ?? 0) !== 0) continue;
    const rk = Number(p.rnkWidth);
    const rank = rk >= 0 && rk <= 4 ? rk : 1;
    for (const ring of f.loadGeometry()) {
      if (ring.length < 2) continue;
      const pts = new Float32Array(ring.length * 2);
      for (let k = 0; k < ring.length; k++) {
        const lon = tileXToLon(tx + ring[k].x / ext, z);
        const lat = tileYToLat(ty + ring[k].y / ext, z);
        const [x, zz] = toXZ(lon, lat);
        pts[k * 2] = x;
        pts[k * 2 + 1] = zz;
      }
      const onEdge = (q: { x: number; y: number }) => q.x <= 0 || q.y <= 0 || q.x >= ext || q.y >= ext;
      const line: RoadLine = {
        id: nextId(),
        pts,
        rank,
        ctg: Number(p.rdCtg ?? 2),
        startShift: -1,
        endShift: -1,
        startNode: -1,
        endNode: -1,
        startCut: onEdge(ring[0]),
        endCut: onEdge(ring[ring.length - 1]),
        length: 0,
      };
      line.length = polylineLength(pts);
      if (line.length >= 1) out.push(line);
    }
  }
  return out;
}

export function polylineLength(pts: Float32Array): number {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
}

export async function fetchRoadTile(
  x: number,
  y: number,
  url: (z: number, x: number, y: number) => string = tileUrl,
): Promise<RoadLayerLike | null> {
  const res = await fetch(url(ZOOM, x, y));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tile = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
  return (tile.layers.road as unknown as RoadLayerLike) ?? null;
}

// ---------------------------------------------------------------------------
// 交差点（3 本以上の道が 1 点に集まる所）を見つける
// ---------------------------------------------------------------------------
export type Arm = {
  line: RoadLine;
  atStart: boolean;
  /** 交差点から道に沿って離れる向き（長さ 1） */
  ax: number;
  az: number;
};
export type RoadNode = { id: number; x: number; z: number; arms: Arm[]; maxRank: number };

/** 道の幅の半分 */
export const halfRoad = (rank: number) => ROAD_WIDTH[Math.max(0, Math.min(4, rank))] / 2;

/**
 * 全ての線の端点を集めて、3 本以上が集まる点を交差点とする。
 * 各線の端に「交差点中心→道の縁（交わる道の幅の半分）」の距離も入れる。
 */
export function analyzeNodes(lines: RoadLine[]): RoadNode[] {
  const map = new Map<string, RoadNode>();
  const key = (x: number, z: number) => `${Math.round(x / 1.5)},${Math.round(z / 1.5)}`;
  const add = (line: RoadLine, atStart: boolean) => {
    const p = line.pts;
    const n = p.length / 2;
    const i0 = atStart ? 0 : n - 1;
    const i1 = atStart ? 1 : n - 2;
    const x = p[i0 * 2], z = p[i0 * 2 + 1];
    let dx = p[i1 * 2] - x, dz = p[i1 * 2 + 1] - z;
    // 端のすぐ次の点が近すぎると向きが不安定なので、少し先の点を使う
    for (let k = 2; Math.hypot(dx, dz) < 3 && k < n; k++) {
      const j = atStart ? k : n - 1 - k;
      dx = p[j * 2] - x;
      dz = p[j * 2 + 1] - z;
    }
    const len = Math.hypot(dx, dz) || 1;
    const k = key(x, z);
    let node = map.get(k);
    if (!node) {
      node = { id: map.size, x, z, arms: [], maxRank: 0 };
      map.set(k, node);
    }
    node.arms.push({ line, atStart, ax: dx / len, az: dz / len });
    node.maxRank = Math.max(node.maxRank, line.rank);
  };
  for (const l of lines) {
    if (!l.startCut) add(l, true);
    if (!l.endCut) add(l, false);
  }
  const nodes: RoadNode[] = [];
  for (const node of map.values()) {
    if (node.arms.length < 3) continue;
    node.id = nodes.length;
    nodes.push(node);
    for (const arm of node.arms) {
      let cross = 0;
      for (const o of node.arms) if (o !== arm) cross = Math.max(cross, halfRoad(o.line.rank));
      if (arm.atStart) {
        arm.line.startShift = cross;
        arm.line.startNode = node.id;
      } else {
        arm.line.endShift = cross;
        arm.line.endNode = node.id;
      }
    }
  }
  return nodes;
}
