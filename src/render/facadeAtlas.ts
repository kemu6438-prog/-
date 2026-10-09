// 建物の壁の「窓の並び」を、起動時に 1 枚の画像（アトラス）として描いておく。
//
// 以前は壁の 1 画素ごとに、窓の形・桟・看板・配管・室外機…を計算で描いていた（とても重い）。
// これを「あらかじめ描いた画像を 1 回引く」だけにする。GPU の画像機能が遠くや斜めを自動でなめらかにするので、
// 窓の縁のちらつき・にじみも出にくい。
//
// 画像の構成（幅 1024）: 外観の種類 6 つ × [上の階の帯 + 1 階の帯] を縦に積む。
// - 上の階の帯: 横 8 マス × 縦 4 階（1 マス = 128 画素、1 階 = 128 画素）。縦・横ともくり返しても継ぎ目がつながる。
// - 1 階の帯: 横 8 マス × 1 階（店先・看板・シャッター）。くり返さない。
// - 帯の上下には「のりしろ」（くり返しで隣にくる行の複製）を付けて、画像を縮小したときに隣の帯とにじまないようにする。
// 色は「壁の色（建物ごとに別の色を掛ける）」「ガラス（青系。alpha = ガラスの度合い）」「看板などの彩色」を 1 枚に入れる。
import * as THREE from "three/webgpu";

export const ATLAS_W = 1024;
export const BAY_PX = 128;
export const FLOOR_PX = 128;
export const BAYS = 8; // タイルの横のマス数
export const FLOORS = 4; // 上の階の帯の階数
export const UPPER_H = FLOORS * FLOOR_PX; // 512
export const GROUND_H = FLOOR_PX; // 128
export const GUTTER = 8;
export const UPPER_BLOCK = UPPER_H + GUTTER * 2; // 528
export const GROUND_BLOCK = GROUND_H + GUTTER * 2; // 144
export const KIND_BLOCK = UPPER_BLOCK + GROUND_BLOCK; // 672
/** 0〜5: 外観の種類 / 6〜8: 窓のない壁（6 = 一般、7 = レンガ、8 = 石）/ 9: 窓の多い会社のビル */
export const KINDS = 10;
/** 各番号の「描き方」（cellKinds の番号）。窓のない壁は元の外観の目地・床の線だけを描く */
const KIND_STYLE = [0, 1, 2, 3, 4, 5, 0, 4, 5, 0];
export const ATLAS_H = KIND_BLOCK * KINDS; // 6720

type C2 = CanvasRenderingContext2D;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALL = "#ece9e3";
const SLAB = "#cfccc5";
const SLAB_HI = "#f6f4f0";
const FRAME = "#bdbdb9";
const SILL = "#f5f3ef";
const DARK = "#3b3f45";
const GLASS = ["#5a85bd", "#6a97c8", "#7aa6d0", "#4f77a8", "#8bb3d8", "#4768a0"];
const GLASS_DARK = ["#34445a", "#3d4f68", "#46597a"];
const CURTAIN = ["#c9b690", "#d8c9a6", "#b9a07a", "#e2d6bd", "#a9b4a0"];
const SIGNS = ["#c93a33", "#e3b72b", "#2f6fb8", "#2f8f5b", "#f1efe8", "#d56b2a", "#7b4aa0"];

/** 色（c）と、ガラスの度合い（m: 0〜1）を、同じ四角に描く */
class Pen {
  constructor(readonly c: C2, readonly m: C2) {}
  rect(x: number, y: number, w: number, h: number, col: string, mask = 0, alpha = 1) {
    this.c.globalAlpha = alpha;
    this.c.fillStyle = col;
    this.c.fillRect(x, y, w, h);
    this.c.globalAlpha = 1;
    // マスクは「上書き」（その部分のガラスの度合いを mask にする）
    this.m.fillStyle = `rgb(${Math.round(mask * 255)},${Math.round(mask * 255)},${Math.round(mask * 255)})`;
    if (alpha >= 0.99) this.m.fillRect(x, y, w, h);
  }
  /** 色だけ重ねる（ガラスの度合いは変えない）。影・汚れ・線に使う */
  tint(x: number, y: number, w: number, h: number, col: string, alpha: number) {
    this.c.globalAlpha = alpha;
    this.c.fillStyle = col;
    this.c.fillRect(x, y, w, h);
    this.c.globalAlpha = 1;
  }
  vgrad(x: number, y: number, w: number, h: number, top: string, bottom: string, mask: number) {
    const g = this.c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    this.c.fillStyle = g;
    this.c.fillRect(x, y, w, h);
    const v = Math.round(mask * 255);
    this.m.fillStyle = `rgb(${v},${v},${v})`;
    this.m.fillRect(x, y, w, h);
  }
}

const pickOf = <T,>(r: () => number, a: T[]): T => a[Math.min(a.length - 1, Math.floor(r() * a.length))];

/** 窓 1 つ（枠・ガラス・カーテン・窓台・奥行きの影）。座標は 1 マス（128×128）の中 */
function windowAt(p: Pen, r: () => number, x0: number, y0: number, x1: number, y1: number, palette: string[], curtainP: number, frame = 3) {
  p.rect(x0 - frame, y0 - frame, x1 - x0 + frame * 2, y1 - y0 + frame * 2, FRAME, 0);
  const base = pickOf(r, palette);
  const lit = r();
  p.vgrad(x0, y0, x1 - x0, y1 - y0, lit < 0.12 ? "#e8d8a8" : base, lit < 0.12 ? "#cdb77f" : shade(base, 0.72), lit < 0.12 ? 0.45 : 1);
  // 空の映り込み（上のほうを少し明るく）
  p.tint(x0, y0, x1 - x0, (y1 - y0) * 0.35, "#ffffff", 0.1 + r() * 0.1);
  if (r() < curtainP) {
    const full = r() < 0.5;
    const cw = full ? x1 - x0 : (x1 - x0) * (0.35 + r() * 0.3);
    const left = r() < 0.5;
    const cx = full || left ? x0 : x1 - cw;
    p.rect(cx, y0, cw, (y1 - y0) * (0.5 + r() * 0.5), pickOf(r, CURTAIN), 0.25);
  }
  // 奥行き（上と左に影）
  p.tint(x0, y0, x1 - x0, 4, "#000000", 0.35);
  p.tint(x0, y0, 3, y1 - y0, "#000000", 0.2);
  // 窓台
  p.rect(x0 - 5, y1 + frame, x1 - x0 + 10, 4, SILL, 0);
  p.tint(x0 - 5, y1 + frame + 4, x1 - x0 + 10, 3, "#000000", 0.18);
}

/** "#rrggbb" を明るさ k 倍に */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/** 床の継ぎ目（1 階の下端の出っぱり） */
function slab(p: Pen, w = BAY_PX, h = 6) {
  p.rect(0, FLOOR_PX - h, w, h, SLAB, 0);
  p.rect(0, FLOOR_PX - h, w, 1.5, SLAB_HI, 0);
  p.tint(0, FLOOR_PX - h - 6, w, 6, "#000000", 0.05);
}

function pier(p: Pen, r: () => number, ac: boolean) {
  p.tint(0, 0, 10, FLOOR_PX, "#ffffff", 0.35);
  p.tint(BAY_PX - 14, 0, 14, FLOOR_PX, "#000000", 0.12);
  p.tint(BAY_PX - 15, 0, 1.5, FLOOR_PX, "#000000", 0.25);
  if (r() < 0.25) p.rect(BAY_PX * 0.5 - 2, 0, 4, FLOOR_PX - 6, "#5a5d62", 0); // 縦の配管
  else if (ac && r() < 0.5) {
    // 室外機
    const x = 34 + r() * 20, y = 74 + r() * 10;
    p.rect(x, y, 44, 26, "#d5d7d9", 0);
    p.rect(x + 8, y + 5, 16, 16, "#2a2c30", 0);
    p.tint(x, y + 22, 44, 4, "#000000", 0.25);
  }
}

type Cell = (p: Pen, r: () => number, i: number, j: number, win: boolean) => void;

/**
 * どのマスに窓・バルコニーなどを描くか（X = 描く、. = 何もない壁）。8 マス × 4 階。
 * 現実の建物は、何もない壁が 6 割ほどで、窓などがあるのは 4 割ほど。縦に筋が通るように並べつつ、少しずらす。
 * （カーテンウォール = 2 は、もともと全面ガラスの建物なので全部描く）
 */
const WIN_MASK: string[][] = [
  [".XX.....", ".XX.....", ".XX.....", ".XX....."], // 0 事務所（窓は一か所に固めて、あとは壁）
  ["XX......", "XX......", "XX......", "XX......"], // 1 連続窓（一か所だけ）
  ["XXXXXXXX", "XXXXXXXX", "XXXXXXXX", "XXXXXXXX"], // 2 カーテンウォール
  ["X.X.....", "X.X.....", "X.X.....", "X.X....."], // 3 集合住宅
  ["..X.....", "..X.....", "..X.....", "..X....."], // 4 レンガ
  ["X...X...", "X...X...", "X...X...", "X...X..."], // 5 石造り
  ["........", "........", "........", "........"], // 6 窓なし
  ["........", "........", "........", "........"], // 7 窓なし（レンガ）
  ["........", "........", "........", "........"], // 8 窓なし（石）
  ["XX..X.X.", "X..XX.X.", "XX..X.X.", "X.X.X..X"], // 9 窓の多い会社のビル
];
const hasWin = (kind: number, i: number, j: number) => WIN_MASK[kind][j][i] === "X";

const cellKinds: Cell[] = [
  // 0 事務所ビル（格子の窓）
  (p, r, i, _j, win) => {
    if (i % 4 === 3) { pier(p, r, true); slab(p); return; }
    if (win) {
      windowAt(p, r, 31, 28, 97, 84, GLASS, 0.18);
      p.tint(33, 92, 62, 28, "#000000", 0.045); // 窓の下の汚れ
    }
    slab(p);
  },
  // 1 横長の連続窓
  (p, r, i, _j, win) => {
    if (i === 7 || !win) { if (i === 7) pier(p, r, false); slab(p); return; }
    p.rect(0, 28, BAY_PX, 60, FRAME, 0);
    p.vgrad(0, 31, BAY_PX, 54, pickOf(r, GLASS), "#2d4a70", 1);
    p.tint(0, 31, BAY_PX, 20, "#ffffff", 0.12);
    p.tint(0, 31, BAY_PX, 4, "#000000", 0.35);
    p.rect(-3, 31, 6, 54, FRAME, 0);
    p.rect(BAY_PX - 3, 31, 6, 54, FRAME, 0);
    if (r() < 0.2) p.rect(10 + r() * 30, 31, 40 + r() * 30, 30, pickOf(r, CURTAIN), 0.25);
    p.rect(0, 88, BAY_PX, 5, SILL, 0);
    slab(p);
  },
  // 2 ガラスのカーテンウォール
  (p, r) => {
    const g = pickOf(r, GLASS);
    p.vgrad(5, 8, BAY_PX - 10, 90, shade(g, 1.05), shade(g, 0.7), 1);
    p.tint(5, 8, BAY_PX - 10, 26, "#ffffff", 0.08 + r() * 0.16);
    p.rect(5, 98, BAY_PX - 10, 24, "#5f6e7c", 0.5); // 腰の壁（スパンドレル）
    p.rect(0, 0, 5, FLOOR_PX, "#aeb3b8", 0.2);
    p.rect(BAY_PX - 5, 0, 5, FLOOR_PX, "#aeb3b8", 0.2);
    p.rect(0, FLOOR_PX - 6, BAY_PX, 6, "#aeb3b8", 0.2);
    if (r() < 0.08) p.rect(5, 8, BAY_PX - 10, 90, pickOf(r, CURTAIN), 0.3);
  },
  // 3 集合住宅（ベランダ）
  (p, r, i, _j, win) => {
    if (i % 4 === 3) { pier(p, r, true); slab(p, BAY_PX, 8); return; }
    if (i % 2 === 1) p.tint(0, 0, BAY_PX, FLOOR_PX, "#000000", 0.05); // 縦縞の色パネル
    if (!win) { slab(p, BAY_PX, 8); return; }
    windowAt(p, r, 31, 36, 97, 88, GLASS, 0.4, 2);
    // ベランダの手すり
    p.rect(6, 98, 116, 22, "#c8c5be", 0);
    for (let x = 10; x < 120; x += 9) p.rect(x, 100, 2.5, 19, DARK, 0);
    p.rect(6, 98, 116, 3, DARK, 0);
    slab(p, BAY_PX, 8);
    if (r() < 0.3) p.rect(20 + r() * 40, 86, 30, 12, "#e8e6e0", 0); // 洗濯物・ふとん
  },
  // 4 レンガ・タイル張り
  (p, r, i, _j, win) => {
    // 目地
    for (let y = 6; y < FLOOR_PX; y += 8) {
      p.tint(0, y, BAY_PX, 1.3, "#6a625a", 0.22);
      const off = ((y / 8) | 0) % 2 === 0 ? 0 : 8;
      for (let x = off; x < BAY_PX; x += 16) p.tint(x, y - 8, 1.2, 8, "#6a625a", 0.16);
    }
    if (i % 4 === 3 || !win) { slab(p, BAY_PX, 5); return; }
    p.rect(34, 26, 60, 4, "#d9d6cf", 0); // まぐさ（窓の上の石）
    windowAt(p, r, 38, 32, 90, 88, GLASS_DARK, 0.25, 4);
    slab(p, BAY_PX, 5);
  },
  // 5 石造り（縦長のスリット窓）
  (p, r, i, _j, win) => {
    for (let y = 18; y < FLOOR_PX; y += 19) {
      p.tint(0, y, BAY_PX, 1.4, "#55524c", 0.22);
      const off = ((y / 19) | 0) % 2 === 0 ? 0 : 38;
      for (let x = off; x < BAY_PX; x += 76) p.tint(x, y - 19, 1.4, 19, "#55524c", 0.16);
    }
    if (i % 4 === 3 || !win) { slab(p, BAY_PX, 6); return; }
    windowAt(p, r, 52, 12, 76, 100, GLASS_DARK, 0.15, 3);
    slab(p, BAY_PX, 6);
  },
];

/** 1 階（店先）の 1 マス。i = 0..7 */
function groundCell(kind: number, p: Pen, r: () => number, i: number, signPair: string, hasAwning: boolean, shutter: boolean) {
  const glassOnly = kind === 1 || kind === 2;
  const solid = !glassOnly && (i === 3 || i === 5 || i === 7); // 店先は 8 マス中 5 つ。残りは壁・入口の柱
  // 看板の帯
  if (!solid || r() < 0.5) {
    p.rect(0, 5, BAY_PX, 24, signPair, 0);
    p.tint(0, 5, BAY_PX, 3, "#ffffff", 0.3);
    p.tint(0, 26, BAY_PX, 3, "#000000", 0.3);
    if (signPair !== "#f1efe8") for (let k = 0; k < 4; k++) p.rect(12 + k * 26 + r() * 4, 11, 14 + r() * 6, 11, "#f6f3ea", 0, 0.85);
    else for (let k = 0; k < 4; k++) p.rect(12 + k * 26 + r() * 4, 11, 14 + r() * 6, 11, "#33363b", 0, 0.8);
  }
  if (solid) {
    pier(p, r, false);
    p.rect(0, 112, BAY_PX, 16, "#9d9a93", 0);
    return;
  }
  if (hasAwning) {
    const c1 = r() < 0.5 ? "#b84a40" : "#3e7a6b";
    for (let k = 0; k < 8; k++) p.rect(k * 16, 32, 16, 14, k % 2 ? c1 : "#f1efe8", 0);
    p.tint(0, 44, BAY_PX, 4, "#000000", 0.3);
  }
  if (shutter) {
    p.rect(3, 48, BAY_PX - 6, 70, "#8e97a1", 0.15);
    for (let y = 50; y < 118; y += 4) p.tint(3, y, BAY_PX - 6, 1.6, "#000000", 0.22);
    p.tint(3, 48, BAY_PX - 6, 5, "#000000", 0.3);
  } else {
    p.rect(2, 46, BAY_PX - 4, 74, FRAME, 0);
    p.vgrad(5, 49, BAY_PX - 10, 68, "#3c5878", "#1f2c3d", 0.9);
    p.tint(5, 49, BAY_PX - 10, 24, "#ffffff", 0.14);
    if (r() < 0.3) p.rect(10, 70, BAY_PX - 20, 20, pickOf(r, CURTAIN), 0.2, 0.6);
    p.rect(0, 118, BAY_PX, 10, "#8d8a84", 0);
  }
}

function paintUpper(c: C2, m: C2, kind: number, top: number) {
  const p = new Pen(c, m);
  for (const off of [-UPPER_H, 0, UPPER_H]) {
    c.save(); m.save();
    for (const q of [c, m]) { q.beginPath(); q.rect(0, top - GUTTER, ATLAS_W, UPPER_H + GUTTER * 2); q.clip(); }
    for (let j = 0; j < FLOORS; j++) {
      for (let i = 0; i < BAYS; i++) {
        c.save(); m.save();
        for (const q of [c, m]) q.translate(i * BAY_PX, top + off + j * FLOOR_PX);
        // 壁の下地（ほぼ白。建物ごとの色が掛かる）
        p.rect(0, 0, BAY_PX, FLOOR_PX, WALL, 0);
        p.tint(0, 0, BAY_PX, FLOOR_PX, "#000000", 0.0);
        const r = rng(kind * 1009 + j * 31 + i * 7 + 5);
        cellKinds[KIND_STYLE[kind]](p, r, i, j, hasWin(kind, i, j));
        c.restore(); m.restore();
      }
    }
    c.restore(); m.restore();
  }
}

function paintGround(c: C2, m: C2, kind: number, top: number) {
  const p = new Pen(c, m);
  const R = rng(kind * 777 + 3);
  // 2 マスずつ同じ看板の色
  const signs: string[] = [];
  for (let k = 0; k < 4; k++) signs.push(pickOf(R, SIGNS));
  for (let i = 0; i < BAYS; i++) {
    c.save(); m.save();
    for (const q of [c, m]) q.translate(i * BAY_PX, top);
    p.rect(0, 0, BAY_PX, GROUND_H, WALL, 0);
    const r = rng(kind * 313 + i * 17 + 9);
    groundCell(kind, p, r, i, signs[i >> 1], r() < 0.3, r() < 0.2);
    c.restore(); m.restore();
  }
  // のりしろ（上下の端の行を伸ばす。くり返さない帯なので端を延長する）
  for (const q of [c, m]) {
    q.drawImage(q.canvas, 0, top, ATLAS_W, 1, 0, top - GUTTER, ATLAS_W, GUTTER);
    q.drawImage(q.canvas, 0, top + GROUND_H - 1, ATLAS_W, 1, 0, top + GROUND_H, ATLAS_W, GUTTER);
  }
}

/** 上の階の帯の「内容の先頭の行」（画像上の行番号。上が 0）。のりしろの分だけ下げてある */
export const upperTop = (kind: number) => kind * KIND_BLOCK + GUTTER;
export const groundTop = (kind: number) => kind * KIND_BLOCK + UPPER_BLOCK + GUTTER;

let atlas: THREE.DataTexture | null = null;

export function facadeAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  try {
    atlas = buildAtlas();
  } catch (e) {
    // 画像を作れなかったときは、真っ白（壁の色だけ）で続行する
    console.warn("壁の画像を作れませんでした", e);
    atlas = new THREE.DataTexture(new Uint8Array([236, 233, 227, 0]), 1, 1, THREE.RGBAFormat);
    atlas.needsUpdate = true;
  }
  return atlas;
}

function buildAtlas(): THREE.DataTexture {
  const cv = document.createElement("canvas");
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const mk = document.createElement("canvas");
  mk.width = ATLAS_W; mk.height = ATLAS_H;
  const c = cv.getContext("2d", { willReadFrequently: true })!;
  const m = mk.getContext("2d", { willReadFrequently: true })!;
  c.fillStyle = WALL; c.fillRect(0, 0, ATLAS_W, ATLAS_H);
  m.fillStyle = "#000"; m.fillRect(0, 0, ATLAS_W, ATLAS_H);
  for (let k = 0; k < KINDS; k++) {
    paintUpper(c, m, k, upperTop(k));
    if (k < 6) paintGround(c, m, k, groundTop(k)); // 窓なし・会社のビルの種類は、1 階の帯を使わない（1 階は元の種類のものを引く）
  }
  const col = c.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const msk = m.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const out = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const R = rng(12345);
  // 画像の上下を逆にして入れる（データの先頭の行が v=0。描いたときの「上」が v=1 になる）
  for (let y = 0; y < ATLAS_H; y++) {
    const src = y * ATLAS_W * 4;
    const dst = (ATLAS_H - 1 - y) * ATLAS_W * 4;
    for (let x = 0; x < ATLAS_W; x++) {
      const s = src + x * 4, d = dst + x * 4;
      const a = msk[s]; // ガラスの度合い
      // 壁の面に、ごく細かい粒を足す（近くで見たときの質感）
      const n = a < 8 ? (R() - 0.5) * 7 : 0;
      out[d] = Math.max(0, Math.min(255, col[s] + n));
      out[d + 1] = Math.max(0, Math.min(255, col[s + 1] + n));
      out[d + 2] = Math.max(0, Math.min(255, col[s + 2] + n));
      out[d + 3] = a;
    }
  }
  const t = new THREE.DataTexture(out, ATLAS_W, ATLAS_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** 確認用: アトラスを PNG の dataURL にして返す（描いたときの向き） */
export function facadeAtlasPreview(): string {
  const t = facadeAtlas();
  const cv = document.createElement("canvas");
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(ATLAS_W, ATLAS_H);
  const d = t.image.data as Uint8Array;
  for (let y = 0; y < ATLAS_H; y++) img.data.set(d.subarray((ATLAS_H - 1 - y) * ATLAS_W * 4, (ATLAS_H - y) * ATLAS_W * 4), y * ATLAS_W * 4);
  g.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}
