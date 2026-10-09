// 雲。以前は three の空（SkyMesh）に付いている雲を使っていたが、模様が大きくて粗く、計算も重かった。
// ここでは「なめらかな雲の模様」を起動時に 1 枚の画像として作っておき、空のドームに数回引いて重ねる。
//   - 画像は 256×256 の「くり返せる」模様（R: 雲のかたまり、G: 雲の多い所・少ない所のむら）。
//   - 空の方向から、雲の層（平らな面）に投げた位置を求めて引く。遠く（地平線）ほど細かく詰まり、自然な遠近になる。
//   - 太陽に近い側の縁は明るく、厚い所は少し暗く、薄い縁は光が透ける。
import * as THREE from "three/webgpu";
import { clamp, dot, float, mix, normalize, positionLocal, pow, smoothstep, texture, time, vec2, vec3 } from "three/tsl";
import type { N } from "./noise";

const SIZE = 256;

/** くり返せる、なめらかな乱数の重ね合わせ（0〜1）。octaves 個ぶん。 */
function bake(seed: number, octaves: number, baseCells: number): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  let total = 0;
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    const n = baseCells << o; // この層の升目の数（256 を割り切る = くり返しがつながる）
    // 升目の頂点の乱数
    const g = new Float32Array(n * n);
    let a = (seed * 7919 + o * 104729) >>> 0;
    for (let i = 0; i < g.length; i++) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      g[i] = a / 4294967296;
    }
    const step = n / SIZE;
    for (let y = 0; y < SIZE; y++) {
      const fy = y * step;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const wy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
      const y0 = (iy % n) * n, y1 = ((iy + 1) % n) * n;
      for (let x = 0; x < SIZE; x++) {
        const fx = x * step;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const wx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
        const x0 = ix % n, x1 = (ix + 1) % n;
        const v0 = g[y0 + x0] + (g[y0 + x1] - g[y0 + x0]) * wx;
        const v1 = g[y1 + x0] + (g[y1 + x1] - g[y1 + x0]) * wx;
        out[y * SIZE + x] += (v0 + (v1 - v0) * wy) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  // 値が真ん中に集まるので、0〜1 に広げる
  let lo = 1, hi = 0;
  for (let i = 0; i < out.length; i++) { lo = Math.min(lo, out[i]); hi = Math.max(hi, out[i]); }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / Math.max(1e-6, hi - lo);
  return out;
}

let tex: THREE.DataTexture | null = null;
function cloudTexture(): THREE.DataTexture {
  if (tex) return tex;
  const a = bake(11, 6, 4);
  const b = bake(23, 4, 2);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = Math.round(a[i] * 255);
    data[i * 4 + 1] = Math.round(b[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export const CLOUD_RADIUS = 6900;

/** 雲のドーム。カメラの位置に合わせて動かす（毎コマ position をカメラに合わせる） */
export function makeClouds(sunDir: THREE.Vector3, coverage = 0.5): THREE.Mesh {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide });
  m.fog = false;
  const dir: N = normalize(positionLocal as N);
  const h: N = dir.y;
  // 雲の層に投げた位置（地平線に近いほど遠くを見ているので、模様が細かく詰まる）
  const k: N = h.add(0.14);
  const drift: N = vec2(time.mul(0.0022), time.mul(0.0009));
  const p: N = vec2(dir.x, dir.z).div(k).mul(1.5).add(drift);
  const t = cloudTexture();
  const a: N = texture(t, p).r;
  const detail: N = texture(t, p.mul(3.3).add(vec2(0.37, 0.61))).r;
  const region: N = texture(t, p.mul(0.28).add(vec2(0.2, 0.5))).g;
  const d: N = a.mul(0.78).add(detail.mul(0.22));
  // 雲の多い所・少ない所（coverage が大きいほど雲が多い）
  const thr: N = float(0.74 - coverage * 0.3).add(region.sub(0.5).mul(-0.34));
  const body: N = smoothstep(thr, thr.add(0.2), d);
  const thick: N = clamp(d.sub(thr).div(0.28), 0.0, 1.0);
  // 太陽のほうへ少しずらした所の濃さと比べて、日の当たる側は明るく、陰になる側は暗く
  const sx: N = float(sunDir.x), sz: N = float(sunDir.z);
  const toSun: N = vec2(sx, sz).mul(0.02);
  const dl: N = texture(t, p.add(toSun)).r.mul(0.78).add(texture(t, p.mul(3.3).add(vec2(0.37, 0.61)).add(toSun.mul(3.3))).r.mul(0.22));
  const lit: N = clamp(d.sub(dl).mul(5.0).add(0.62), 0.0, 1.0);
  const sunCos: N = dot(dir, vec3(sunDir.x, sunDir.y, sunDir.z));
  const silver: N = pow(clamp(sunCos, 0.0, 1.0), 10.0).mul(float(1.0).sub(thick)).mul(1.3);
  const shadowCol: N = vec3(0.72, 0.78, 0.9);
  const sunCol: N = vec3(1.0, 0.97, 0.9);
  let col: N = mix(shadowCol, sunCol, lit.mul(float(1.0).sub(thick.mul(0.35))));
  col = col.add(vec3(1.0, 0.95, 0.85).mul(silver)).add(vec3(0.25, 0.27, 0.3).mul(float(1.0).sub(thick)).mul(0.5));
  // 地平線に近いほど、空のかすみに溶ける
  const haze: N = float(1.0).sub(smoothstep(0.0, 0.4, h));
  col = mix(col, vec3(0.78, 0.86, 0.95), haze.mul(0.7));
  const fade: N = smoothstep(0.015, 0.24, h);
  m.colorNode = col.mul(1.55);
  m.opacityNode = body.mul(fade).mul(0.96);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), m);
  mesh.scale.setScalar(CLOUD_RADIUS);
  mesh.frustumCulled = false;
  mesh.renderOrder = -50;
  mesh.name = "clouds";
  return mesh;
}
