// 木・低木・草むらを「絵（テクスチャ）を貼った板」で作る。
// 以前は葉のかたまりを多面体で作り、画素ごとの計算で葉の色むらを出していた。
// 今は、起動時に描いた葉の絵（1 枚、512×512）を、十字に交差させた板に貼る。板の縁は絵の透明部分で切り抜く。
//   - 三角形が少ない（木 1 本 = 約 30 枚。以前は数百枚）ので、本数を増やせる。
//   - 光の当たり方は、板の向きではなく「葉のかたまりの中心から外へ向かう向き」で付ける。板の枚数が見えず、丸い木に見える。
import * as THREE from "three/webgpu";
import { attribute, mix, texture, uv, vec3, vec4 } from "three/tsl";
import type { N } from "./noise";

const W = 512;

type Rect = { x: number; y: number; w: number; h: number }; // 絵の中の場所（上が y=0 の画素）
export const SPR = {
  crownA: { x: 0, y: 0, w: 256, h: 256 } as Rect,
  crownB: { x: 256, y: 0, w: 256, h: 256 } as Rect,
  bush: { x: 0, y: 256, w: 256, h: 256 } as Rect,
  tuft: { x: 256, y: 256, w: 256, h: 224 } as Rect,
  trunk: { x: 400, y: 484, w: 32, h: 24 } as Rect,
};

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

type Ctx = CanvasRenderingContext2D;
const hsl = (h: number, s: number, l: number) => `hsl(${h.toFixed(0)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%)`;

/** 葉のかたまり 1 つ。小さな葉の群れを、奥（暗い）から手前（明るい）へ重ねる */
function foliage(c: Ctx, r: Rect, seed: number, o: { hue: number; count: number; leaf: number; rx: number; ry: number; cy: number; flat?: boolean }) {
  const R = rng(seed);
  const cx = r.x + r.w / 2, cy = r.y + o.cy;
  const items: { x: number; y: number; k: number; a: number; s: number }[] = [];
  for (let i = 0; i < o.count; i++) {
    // 円（楕円）の中。外側に多めに置くと、縁がもこもこする
    const ang = R() * Math.PI * 2;
    const rad = Math.sqrt(R()) * (0.55 + 0.45 * R());
    const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
    items.push({ x, y, k: -(x * 0.55 + y * 0.8), a: R() * Math.PI, s: 0.7 + R() * 0.7 }); // k: 光（左上）の当たり具合
  }
  items.sort((a, b) => a.k - b.k);
  for (const it of items) {
    const px = cx + it.x * o.rx, py = cy + it.y * o.ry;
    if (o.flat && py > r.y + r.h - 20) continue;
    const l = 0.25 + 0.22 * (it.k * 0.5 + 0.5) + R() * 0.07;
    c.fillStyle = hsl(o.hue + (R() - 0.5) * 18, 0.5 + R() * 0.12, l);
    c.beginPath();
    c.ellipse(px, py, o.leaf * it.s, o.leaf * 0.62 * it.s, it.a, 0, Math.PI * 2);
    c.fill();
    // 葉の中央の明るい点（光が当たっている所）
    if (it.k > 0.1 && R() < 0.7) {
      c.fillStyle = hsl(o.hue + 6, 0.55, 0.5 + 0.12 * R());
      c.beginPath();
      c.ellipse(px - o.leaf * 0.2, py - o.leaf * 0.2, o.leaf * 0.35 * it.s, o.leaf * 0.2 * it.s, it.a, 0, Math.PI * 2);
      c.fill();
    }
  }
  // 葉のすきま（向こうが透ける穴）を縁のあたりに少し
  c.save();
  c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 16; i++) {
    const ang = R() * Math.PI * 2, rad = 0.6 + R() * 0.38;
    c.beginPath();
    c.ellipse(cx + Math.cos(ang) * rad * o.rx, cy + Math.sin(ang) * rad * o.ry, 4 + R() * 9, 3 + R() * 7, R() * 3, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
  // 下側を少し暗く（かたまりの下は光が届かない）
  c.save();
  c.globalCompositeOperation = "source-atop";
  const g = c.createLinearGradient(0, cy - o.ry, 0, cy + o.ry);
  g.addColorStop(0, "rgba(255,255,200,0.10)");
  g.addColorStop(0.5, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,20,0,0.38)");
  c.fillStyle = g;
  c.fillRect(r.x, r.y, r.w, r.h);
  c.restore();
}

/** 草むら: 根もとから先へ細くなる葉を扇形に */
function grassTuft(c: Ctx, r: Rect, seed: number) {
  const R = rng(seed);
  const baseY = r.y + r.h - 4;
  const blades: { x: number; h: number; lean: number; w: number; l: number }[] = [];
  for (let i = 0; i < 46; i++) {
    const t = R();
    blades.push({ x: r.x + 40 + t * (r.w - 80), h: 70 + R() * 120 * (1 - Math.abs(t - 0.5) * 0.7), lean: (t - 0.5) * 90 + (R() - 0.5) * 50, w: 4 + R() * 5, l: 0.28 + R() * 0.3 });
  }
  blades.sort((a, b) => a.l - b.l);
  for (const b of blades) {
    const tipX = b.x + b.lean, tipY = baseY - b.h;
    const g = c.createLinearGradient(0, baseY, 0, tipY);
    g.addColorStop(0, hsl(95, 0.5, b.l * 0.55));
    g.addColorStop(1, hsl(88, 0.6, b.l + 0.18));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(b.x - b.w, baseY);
    c.quadraticCurveTo(b.x - b.w * 0.4 + b.lean * 0.1, baseY - b.h * 0.55, tipX, tipY);
    c.quadraticCurveTo(b.x + b.w * 0.4 + b.lean * 0.5, baseY - b.h * 0.5, b.x + b.w, baseY);
    c.closePath();
    c.fill();
  }
}

let atlas: THREE.DataTexture | null = null;

export function plantAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  try {
    atlas = build();
  } catch (e) {
    console.warn("葉の絵を作れませんでした", e);
    atlas = new THREE.DataTexture(new Uint8Array([70, 120, 45, 255]), 1, 1, THREE.RGBAFormat);
    atlas.needsUpdate = true;
  }
  return atlas;
}

function build(): THREE.DataTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const c = cv.getContext("2d", { willReadFrequently: true })!;
  c.clearRect(0, 0, W, W);
  foliage(c, SPR.crownA, 11, { hue: 98, count: 520, leaf: 11, rx: 118, ry: 112, cy: 128 });
  foliage(c, SPR.crownB, 23, { hue: 84, count: 560, leaf: 10, rx: 120, ry: 104, cy: 128 });
  foliage(c, SPR.bush, 37, { hue: 104, count: 380, leaf: 12, rx: 118, ry: 82, cy: 156, flat: true });
  grassTuft(c, SPR.tuft, 51);
  // 幹の色（小さな四角）
  c.fillStyle = "#6a5240";
  c.fillRect(SPR.trunk.x, SPR.trunk.y, SPR.trunk.w, SPR.trunk.h);
  const src = c.getImageData(0, 0, W, W).data;
  const out = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const d = ((W - 1 - y) * W + x) * 4; // 上下を逆にして入れる（先頭の行が v=0）
      const a = src[s + 3];
      if (a < 6) {
        // 透明な所の色は、縮小したときに縁が黒ずまないよう、葉の平均の緑にしておく
        out[d] = 74; out[d + 1] = 118; out[d + 2] = 46; out[d + 3] = 0;
      } else {
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = a;
      }
    }
  }
  const t = new THREE.DataTexture(out, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// 形（板）
// ---------------------------------------------------------------------------
class Cards {
  pos: number[] = [];
  nor: number[] = [];
  uvs: number[] = [];
  idx: number[] = [];
  private uvOf(r: Rect, fx: number, fy: number, inset = 1.5): [number, number] {
    // fx, fy: 0〜1（左→右 / 下→上）
    const u = (r.x + inset + (r.w - inset * 2) * fx) / W;
    const v = 1 - (r.y + inset + (r.h - inset * 2) * (1 - fy)) / W;
    return [u, v];
  }
  /** 中心 c、横の半分の長さベクトル a、縦の半分の長さベクトル b の板（表と裏の 2 枚）。法線は normalAt(x,y,z) で決める */
  quad(c: [number, number, number], a: [number, number, number], b: [number, number, number], r: Rect, normalAt: (x: number, y: number, z: number) => [number, number, number]) {
    const corners: [number, number, number, number, number][] = [[-1, -1, 0, 0, 0], [1, -1, 1, 0, 0], [1, 1, 1, 1, 0], [-1, 1, 0, 1, 0]];
    for (const back of [false, true]) {
      const base = this.pos.length / 3;
      for (const [sx, sy, fx, fy] of corners) {
        const x = c[0] + a[0] * sx + b[0] * sy, y = c[1] + a[1] * sx + b[1] * sy, z = c[2] + a[2] * sx + b[2] * sy;
        this.pos.push(x, y, z);
        this.nor.push(...normalAt(x, y, z));
        this.uvs.push(...this.uvOf(r, fx, fy));
      }
      // 表: 反時計回り / 裏: 逆向き（同じ位置に重ねて、どちらから見ても見える）
      if (!back) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  /** 筒（幹）。絵の幹の色の所を指す */
  trunk(r0: number, r1: number, h: number, seg: number, r: Rect) {
    const [u, v] = this.uvOf(r, 0.5, 0.5, 6);
    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const cx = Math.cos(t), sz = Math.sin(t);
      this.pos.push(cx * r0, 0, sz * r0, cx * r1, h, sz * r1);
      this.nor.push(cx, 0.1, sz, cx, 0.1, sz);
      this.uvs.push(u, v, u, v);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** 中心 (cx,cy,cz) から外へ向かう向き（少し上向きに寄せる）= 丸いかたまりのような光の当たり方 */
const radial = (cx: number, cy: number, cz: number, up = 0.35) => (x: number, y: number, z: number): [number, number, number] => {
  const dx = x - cx, dy = y - cy + 0.0, dz = z - cz;
  const l = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / l, ny = dy / l + up, nz = dz / l;
  const m = Math.hypot(nx, ny, nz) || 1;
  return [nx / m, ny / m, nz / m];
};

/** 街路樹: 幹 + 十字の葉の板 3 枚 + 下から見える水平の板 */
export function treeCardGeometry(variant: 0 | 1): THREE.BufferGeometry {
  const k = new Cards();
  k.trunk(0.1, 0.2, 3.5, 6, SPR.trunk);
  const spr = variant === 0 ? SPR.crownA : SPR.crownB;
  const cy = 5.3, hw = 3.1, hh = 2.9;
  const nrm = radial(0, cy, 0);
  for (let i = 0; i < 3; i++) {
    const t = (i / 3) * Math.PI + 0.3;
    k.quad([0, cy, 0], [Math.cos(t) * hw, 0, Math.sin(t) * hw], [0, hh, 0], spr, nrm);
  }
  // 水平の板（見上げたとき、枝の下に葉が広がって見える）
  k.quad([0, cy - 0.9, 0], [hw * 0.8, 0, 0], [0, 0, hw * 0.8], spr, radial(0, cy + 2, 0, 0.0));
  return k.geometry();
}

/** 低木: 低い茂み。十字の 2 枚 + 水平の 1 枚 */
export function bushCardGeometry(): THREE.BufferGeometry {
  const k = new Cards();
  const cy = 0.55, hw = 0.85, hh = 0.62;
  const nrm = radial(0, cy, 0, 0.3);
  for (let i = 0; i < 2; i++) {
    const t = (i / 2) * Math.PI + 0.5;
    k.quad([0, cy, 0], [Math.cos(t) * hw, 0, Math.sin(t) * hw], [0, hh, 0], SPR.bush, nrm);
  }
  k.quad([0, cy + 0.15, 0], [hw * 0.8, 0, 0], [0, 0, hw * 0.8], SPR.bush, () => [0, 1, 0]);
  return k.geometry();
}

/** 草むら: 3 枚の板を 60 度ずつ回して立てる。光は上向きの面として当てる */
export function tuftCardGeometry(): THREE.BufferGeometry {
  const k = new Cards();
  const hw = 0.5, hh = 0.44;
  for (let i = 0; i < 3; i++) {
    const t = (i / 3) * Math.PI + 0.2;
    k.quad([0, hh, 0], [Math.cos(t) * hw, 0, Math.sin(t) * hw], [0, hh, 0], SPR.tuft, () => [0, 1, 0]);
  }
  return k.geometry();
}

/** 板の材質。絵の色に、1 本ごとの色の個体差（tint 属性）を掛ける。透明な所は切り抜き（影も同じ形で落ちる） */
export function cardMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const t: N = texture(plantAtlas(), uv());
  const tint: N = attribute("tint", "float");
  const leafTint: N = mix(vec3(1.2, 1.02, 0.72), vec3(0.86, 1.05, 0.92), tint);
  m.colorNode = vec4(t.rgb.mul(leafTint), t.a);
  m.alphaTest = 0.45;
  m.alphaToCoverage = true; // 縁を MSAA でなめらかに
  return m;
}
