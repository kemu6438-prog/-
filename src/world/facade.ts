// LOD1 の建物（のっぺりした箱）を、窓・階・屋根・建物ごとの色で「建物らしく」塗るシェーダー。
// 画風の方針: 色は鮮やか寄りのやわらかいパステル、光はリアル寄り（MHST3 を目標にした絵作り）。
// 実装は three の TSL（WebGPU と WebGL 2 の両方で動くシェーダー言語）。
import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, cross, dFdx, dFdy, dot, float, floor,
  fract, length, max, mix, normalize, positionView, positionWorld, smoothstep, step, vec2, vec3, viewportSize,
} from "three/tsl";
import { hash21, vnoise, type N } from "../render/noise";
import { TEX } from "../render/assets";

/** 0〜1 の疑似乱数（建物 ID 用） */
const hash = (x: N): N => fract(x.mul(12.9898).add(78.233).sin().mul(43758.5453));

type Out = { color: N; roughness: N; metalness: N };

/** 番号(0..5)ごとの数値を選ぶ（s は 0〜5 の小数） */
const pick = (s: N, vals: number[]): N => {
  let r: N = float(vals[0]);
  for (let i = 1; i < vals.length; i++) r = mix(r, float(vals[i]), step(i - 0.5, s));
  return r;
};

/**
 * 外観の種類（s）:
 * 0 事務所ビル（格子の窓）/ 1 横長の連続窓 / 2 ガラスのカーテンウォール
 * 3 集合住宅（ベランダ）/ 4 レンガ・タイル張り / 5 石造り（縦長のスリット窓）
 */
function buildLook(id: N): Out {
  const h1 = hash(id);
  const h2 = hash(id.add(17.3));
  const h3 = hash(id.add(41.7));
  const hs = hash(id.add(77.7));

  // 高さ（ワールド座標の y）
  const y: N = positionWorld.y;

  // 外観の種類。高いところ(36m〜)は、低層向きの種類をやめて事務所・連続窓・ガラスにする（下が低層、上が高層）
  const s0: N = step(0.25, hs).add(step(0.4, hs)).add(step(0.55, hs)).add(step(0.75, hs)).add(step(0.9, hs));
  const sTall: N = mix(s0, floor(h2.mul(2.999)), step(2.5, s0));
  const s: N = mix(s0, sTall, step(36.0, y));

  const bayW: N = pick(s, [3.4, 2.8, 1.8, 3.0, 3.2, 2.4]);
  const floorH: N = pick(s, [3.6, 3.8, 3.8, 3.0, 3.2, 3.6]);

  // --- 面の向き（カメラからの相対位置で計算するので、近づいても荒れない） ---
  const pv: N = positionView as N;
  const faceV: N = normalize(cross(dFdx(pv) as N, dFdy(pv) as N));
  const faceN: N = faceV.transformNormalByInverseViewMatrix(cameraViewMatrix);
  const wallMask: N = step(abs(faceN.y), 0.5);
  const tangent: N = normalize(vec2(faceN.z.negate(), faceN.x));
  // 1 ピクセルが現実で何メートルか（遠い・斜めほど大きい）
  const dist: N = length(pv);
  const pixAngle: N = float(2.0).div((cameraProjectionMatrix as N).element(1).y.mul(viewportSize.y));
  const cosv: N = max(abs(dot(normalize(pv), faceV)), 0.12);
  const pw: N = dist.mul(pixAngle).div(cosv);

  const uMeters: N = dot(vec2(positionWorld.x, positionWorld.z), tangent).add(h2.mul(37.0));
  const u: N = uMeters.div(bayW);
  const v: N = y.div(floorH);
  const fu: N = fract(u);
  const fv: N = fract(v);
  // --- 描く細かさ（LOD）: 近い物に力を回し、遠い物・見上げる高さ・高層の最上部は簡単にする ---
  // 地上（カメラが低い）のときだけ、カメラより 18〜45m 以上高いところを簡単な塗りにする（上空からは普通に描く）
  const street: N = float(1.0).sub(smoothstep(20.0, 70.0, (cameraPosition as N).y));
  const upper: N = street.mul(smoothstep(18.0, 45.0, y.sub((cameraPosition as N).y)));
  // 高層ビルのいちばん上のほう（地上から 100〜140m 以上）は、窓も模様も描かない
  const topFlat: N = smoothstep(100.0, 140.0, y);
  const simple: N = clamp(upper.add(topFlat), 0.0, 1.0);
  const fp0: N = max(pw.div(bayW), pw.div(floorH)).max(0.0005);
  // 簡単にするぶん、1 ピクセルが大きいことにして、窓が平らな色にとけるようにする
  const fp: N = fp0.add(simple.mul(0.6));
  const edge = (e: N, x: N): N => smoothstep(e.sub(fp), e.add(fp), x);
  const far: N = smoothstep(0.05, 0.17, fp);
  const near: N = float(1.0).sub(smoothstep(0.03, 0.12, fp));
  // 細い枠・桟は、1 ピクセルより細くなったらすぐ消す（白いちらつきの原因）
  const crisp: N = float(1.0).sub(smoothstep(0.012, 0.045, fp));
  // すぐ目の前（約 10m 以内）だけの、さらに細かい質感
  const close: N = float(1.0).sub(smoothstep(0.004, 0.02, fp));
  const isGround: N = float(1.0).sub(step(1.0, v));

  // --- 窓の形（種類ごと） ---
  const l0: N = pick(s, [0.16, 0.0, 0.04, 0.2, 0.3, 0.4]);
  const r0: N = pick(s, [0.84, 1.0, 0.96, 0.8, 0.7, 0.6]);
  const b0: N = pick(s, [0.3, 0.3, 0.06, 0.28, 0.32, 0.1]);
  const t0: N = pick(s, [0.82, 0.8, 0.94, 0.82, 0.76, 0.9]);
  // 1 階は店先の広いガラス（ガラスの建物は全部ガラスのまま）
  const shop: N = isGround.mul(step(s, 1.5).max(step(2.5, s)));
  const l: N = mix(l0, float(0.07), shop);
  const r: N = mix(r0, float(0.93), shop);
  const b: N = mix(b0, float(0.12), shop);
  const t: N = mix(t0, float(0.68), shop);
  const win: N = edge(l, fu).mul(float(1.0).sub(edge(r, fu))).mul(edge(b, fv)).mul(float(1.0).sub(edge(t, fv)));
  // 連続窓・カーテンウォールの縦の桟（細い線）
  const isBand: N = step(0.5, s).mul(step(s, 2.5));
  const mull: N = float(1.0).sub(isBand.mul(float(1.0).sub(edge(float(0.06), fu)).mul(crisp).mul(0.9)));
  const winM: N = win.mul(mull);
  const outer: N = edge(l.sub(0.035), fu)
    .mul(float(1.0).sub(edge(r.add(0.035), fu)))
    .mul(edge(b.sub(0.03), fv))
    .mul(float(1.0).sub(edge(t.add(0.03), fv)));
  const frame: N = clamp(outer.sub(win), 0.0, 1.0).add(float(1.0).sub(mull).mul(win)).mul(crisp);
  const hasWindows: N = step(0.06, h3);

  // --- ガラス ---
  const cellFade: N = float(1.0).sub(smoothstep(0.04, 0.14, fp));
  const cell: N = vec2(floor(u), floor(v));
  const wh: N = hash21(cell.add(vec2(h1.mul(113.0), h2.mul(57.0))));
  const curtainP: N = mix(float(0.84), float(0.62), step(2.5, s).mul(step(s, 3.5)));
  const curtain: N = step(curtainP, wh).mul(cellFade).mul(float(1.0).sub(isGround)).mul(float(1.0).sub(step(1.5, s).mul(step(s, 2.5))));
  const glassBlue: N = mix(vec3(0.2, 0.33, 0.5), vec3(0.55, 0.74, 0.9), h2.mul(h2));
  const glassTeal: N = mix(vec3(0.12, 0.3, 0.34), vec3(0.4, 0.62, 0.66), h2);
  const glassDark: N = vec3(0.1, 0.14, 0.2);
  const glassWall: N = mix(glassBlue, glassTeal, step(0.5, h1));
  const glassKind: N = mix(glassWall, glassDark, step(3.5, s));
  const glassShop: N = vec3(0.14, 0.2, 0.28);
  // 窓の奥行き: 上と左に影（窓枠のへこみ）
  const wy: N = clamp(fv.sub(b).div(t.sub(b)), 0.0, 1.0);
  const wx: N = clamp(fu.sub(l).div(r.sub(l).max(0.01)), 0.0, 1.0);
  const reveal: N = float(1.0).sub(smoothstep(0.78, 1.0, wy).mul(0.45).add(float(1.0).sub(smoothstep(0.0, 0.14, wx)).mul(0.25)).mul(near));
  const glassTone: N = mix(glassKind, glassShop, shop).mul(mix(float(1.0), mix(float(0.72).add(wh.mul(0.55)), float(0.88).add(wh.mul(0.24)), step(1.5, s).mul(step(s, 2.5))), cellFade)).mul(reveal);
  const glassColor: N = mix(glassTone, vec3(0.74, 0.68, 0.56), curtain.mul(0.85));
  const winAmount: N = mix(winM.mul(hasWindows), hasWindows.mul(mix(float(0.34), float(0.9), step(1.5, s).mul(step(s, 2.5)))), far);

  // --- 壁の色（種類ごと） ---
  const cream = vec3(0.95, 0.9, 0.78);
  const peach = vec3(0.95, 0.78, 0.62);
  const blue = vec3(0.72, 0.8, 0.86);
  const sage = vec3(0.76, 0.82, 0.68);
  const warm: N = mix(cream, peach, smoothstep(0.0, 0.33, h1));
  const cool: N = mix(blue, sage, smoothstep(0.55, 0.85, h1));
  const pastel: N = mix(warm, cool, smoothstep(0.33, 0.66, h1)).mul(float(0.88).add(h3.mul(0.2)));
  const modern: N = mix(vec3(0.78, 0.8, 0.82), vec3(0.9, 0.9, 0.88), h3).mul(float(0.9).add(h2.mul(0.15)));
  const dwelling: N = mix(vec3(0.93, 0.84, 0.7), vec3(0.78, 0.84, 0.72), h1).mul(float(0.9).add(h3.mul(0.15)));
  const brickC: N = mix(vec3(0.5, 0.26, 0.2), vec3(0.68, 0.58, 0.44), step(0.5, h3)).mul(float(0.85).add(h2.mul(0.25)));
  const stoneC: N = mix(vec3(0.8, 0.77, 0.7), vec3(0.62, 0.62, 0.6), h1).mul(float(0.92).add(h3.mul(0.12)));
  let wallBase: N = pastel;
  wallBase = mix(wallBase, modern, step(0.5, s));
  wallBase = mix(wallBase, glassDark.mul(1.4), step(1.5, s));
  wallBase = mix(wallBase, dwelling, step(2.5, s));
  wallBase = mix(wallBase, brickC, step(3.5, s));
  wallBase = mix(wallBase, stoneC, step(4.5, s));

  // 壁のむら・汚れ
  const surf: N = mix(vec2(positionWorld.x, positionWorld.z), vec2(uMeters, y), wallMask);
  const mott: N = vnoise(surf.mul(0.3)).mul(0.5).add(vnoise(surf.mul(1.3)).mul(0.3)).add(vnoise(surf.mul(6.0)).mul(0.2).mul(near));
  const mottle: N = float(0.86).add(mott.mul(0.28).mul(float(1.0).sub(simple.mul(0.7))));
  const streak: N = vnoise(vec2(uMeters.mul(1.5), floor(v).mul(3.1))).mul(float(1.0).sub(fv)).mul(0.2).mul(near).mul(wallMask);

  // レンガ・石の目地（近いときだけ）
  const brickFade: N = float(1.0).sub(smoothstep(0.03, 0.14, pw));
  const row: N = floor(y.div(0.075));
  const bx: N = fract(uMeters.div(0.25).add(row.mul(0.5)));
  const brickLine: N = step(bx, 0.05).max(step(fract(y.div(0.075)), 0.1)).mul(brickFade);
  const stoneRow: N = floor(y.div(0.45));
  const sx: N = fract(uMeters.div(0.9).add(stoneRow.mul(0.37)));
  const stoneLine: N = step(sx, 0.025).max(step(fract(y.div(0.45)), 0.04)).mul(float(1.0).sub(smoothstep(0.05, 0.25, pw)));
  const mortar: N = brickLine.mul(step(3.5, s).mul(step(s, 4.5))).mul(float(1.0).sub(TEX.brick.on)).add(stoneLine.mul(step(4.5, s))).mul(0.22);

  // 集合住宅: ベランダ（手すりと床の出っぱり）と、縦縞の色パネル
  const isDwell: N = step(2.5, s).mul(step(s, 3.5));
  const rail: N = isDwell.mul(float(1.0).sub(edge(float(0.24), fv))).mul(edge(float(0.05), fv)).mul(near);
  const slabLine: N = isDwell.mul(float(1.0).sub(edge(float(0.05), fv))).mul(near);
  const panel: N = isDwell.mul(step(0.5, fract(floor(u).mul(0.5).add(h2)))).mul(0.12);

  // 床の継ぎ目・ひさし・窓の下の影
  const slab: N = float(1.0).sub(float(1.0).sub(edge(float(0.07), fv)).mul(0.16).mul(near));
  const sill: N = float(1.0).sub(edge(float(0.3), fv).mul(float(1.0).sub(edge(float(0.36), fv))).mul(0.22).mul(near).mul(float(1.0).sub(isDwell)));
  const cornice: N = float(1.0).add(edge(float(0.93), fv).mul(0.07).mul(near));
  const grounded: N = mix(float(0.7), float(1.0), smoothstep(0.0, 14.0, y));

  // ネットの素材（読み込めたら）: 壁・屋根はコンクリートの肌、レンガの壁は本物のレンガ模様
  const isBrickS: N = step(3.5, s).mul(step(s, 4.5));
  const concreteD: N = TEX.wall.detail(surf);
  const brickD: N = TEX.brick.detail(vec2(uMeters, y));
  const detailK: N = float(1.0).sub(simple);
  // 近いほど壁の質感を少しはっきり（コントラストを上げる）、簡単にする所は平らに
  const grain: N = float(1.0).add(vnoise(surf.mul(18.0)).sub(0.5).mul(0.22).mul(close));
  const texD: N = mix(mix(vec3(1, 1, 1), concreteD, mix(0.2, mix(0.75, 0.95, close), detailK)), brickD, isBrickS.mul(wallMask).mul(detailK)).mul(grain);
  let wallBody: N = wallBase.mul(texD).mul(slab).mul(sill).mul(cornice).mul(mottle).mul(float(1.0).sub(streak)).mul(float(1.0).sub(panel)).mul(float(1.0).sub(mortar));
  wallBody = mix(wallBody, vec3(0.3, 0.32, 0.34), rail.mul(0.85));
  wallBody = mix(wallBody, wallBody.mul(0.65), slabLine);
  const sash: N = vec3(0.7, 0.7, 0.68);
  wallBody = mix(wallBody, sash, frame.mul(hasWindows).mul(0.6).mul(step(s, 1.5).max(step(2.5, s)).max(0.4)));

  // 1 階の看板と、ひさし
  const signBand: N = shop.mul(edge(float(0.76), fv)).mul(float(1.0).sub(edge(float(0.97), fv)));
  const signId: N = floor(uMeters.div(5.0)).add(h1.mul(31.0));
  const sh: N = hash(signId);
  const signCol: N = mix(mix(vec3(0.85, 0.15, 0.15), vec3(0.95, 0.8, 0.15), step(0.33, sh)), mix(vec3(0.15, 0.4, 0.8), vec3(0.2, 0.55, 0.35), step(0.8, sh)), step(0.66, sh));
  const letters: N = step(0.5, vnoise(vec2(uMeters.mul(2.4), 0.0)).add(0.0)).mul(near);
  const hasSign: N = step(0.4, hash(signId.add(5.0)));
  const signColor: N = mix(signCol, vec3(0.97, 0.97, 0.95), letters.mul(0.55));
  wallBody = mix(wallBody, signColor, signBand.mul(hasSign).mul(near).mul(float(1.0).sub(step(1.5, s).mul(step(s, 2.5)))));
  const awningColor: N = mix(vec3(0.75, 0.3, 0.28), vec3(0.28, 0.5, 0.45), step(0.5, h1));
  const awning: N = shop.mul(edge(float(0.68), fv)).mul(float(1.0).sub(edge(float(0.76), fv))).mul(step(0.45, h2));
  wallBody = mix(wallBody, awningColor, awning.mul(near));

  // 2〜3 階あたりの縦型の突き出し看板（ときどき）
  const vId: N = floor(uMeters.div(4.0)).add(h2.mul(53.0));
  const vHas: N = step(0.9, hash(vId)).mul(step(1.0, v)).mul(step(v, 3.6)).mul(step(s, 4.5));
  const vx: N = fract(uMeters.div(4.0));
  const vBox: N = edge(float(0.82), vx).mul(float(1.0).sub(edge(float(0.94), vx))).mul(vHas).mul(near).mul(wallMask);
  const vCol: N = mix(mix(vec3(0.9, 0.12, 0.12), vec3(0.95, 0.85, 0.1), step(0.33, hash(vId.add(1.0)))), vec3(0.15, 0.45, 0.85), step(0.66, hash(vId.add(1.0))));
  const vStripe: N = step(0.5, fract(y.mul(1.4)));
  wallBody = mix(wallBody, mix(vCol, vec3(0.97, 0.97, 0.95), vStripe.mul(0.7)), vBox);

  const wallColor: N = mix(wallBody, glassColor, winAmount).mul(grounded);

  // --- 屋根 ---
  const roofGrey: N = mix(vec3(0.5, 0.52, 0.54), vec3(0.45, 0.53, 0.48), step(0.55, h2));
  const roofBase: N = mix(roofGrey, vec3(0.62, 0.34, 0.27), step(0.94, h2)).mul(float(0.85).add(h3.mul(0.2)));
  const rp: N = vec2(positionWorld.x, positionWorld.z);
  const seam: N = step(fract(rp.x.div(6.0)), 0.012).max(step(fract(rp.y.div(6.0)), 0.012)).mul(float(1.0).sub(smoothstep(0.05, 0.3, pw))).mul(0.18);
  const roofColor: N = roofBase.mul(mix(vec3(1, 1, 1), concreteD, 0.8)).mul(float(0.8).add(vnoise(rp.mul(0.7)).mul(0.4))).mul(float(0.92).add(vnoise(rp.mul(5.0)).mul(0.16).mul(near))).mul(float(1.0).sub(seam));

  // --- つや: 壁・屋根はざらざら、ガラスはつるつる＋映り込み ---
  const isCurtainWall: N = step(1.5, s).mul(step(s, 2.5));
  const glassRough: N = mix(mix(float(0.07), float(0.04), isCurtainWall), float(0.7), curtain);
  const roughness: N = mix(float(0.9), mix(float(0.88), glassRough, winAmount), wallMask);
  const metalness: N = winAmount.mul(float(1.0).sub(curtain)).mul(mix(float(0.55), float(0.8), isCurtainWall)).mul(wallMask);

  return { color: mix(roofColor, wallColor, wallMask), roughness, metalness };
}

const cache = new Map<string, THREE.MeshStandardNodeMaterial>();

/**
 * 建物 ID の頂点属性名（`_batchid` など。無ければ null）に応じた材質。
 * 属性が無いときは、おおまかな位置から疑似的な建物 ID を作る。
 */
export function facadeMaterial(idAttribute: string | null): THREE.MeshStandardNodeMaterial {
  const key = idAttribute ?? "(none)";
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, flatShading: true });
  const id: N = idAttribute
    ? (attribute(idAttribute, "float") as unknown as N)
    : (positionWorld.x.div(22.0).floor().mul(7.0).add(positionWorld.z.div(22.0).floor().mul(131.0)) as unknown as N);
  const look = buildLook(id);
  m.colorNode = look.color;
  m.roughnessNode = look.roughness;
  m.metalnessNode = look.metalness;
  cache.set(key, m);
  return m;
}

/** 建物 ID の属性名を探す。無ければ null */
export function findIdAttribute(geometry: THREE.BufferGeometry): string | null {
  for (const name of ["_batchid", "_feature_id_0"]) if (geometry.getAttribute(name)) return name;
  return null;
}

/** 整数の属性は GPU 側で型が合わないことがあるので、小数(Float32)に作り替える */
export function ensureFloatAttribute(geometry: THREE.BufferGeometry, name: string) {
  const a = geometry.getAttribute(name);
  if (!a || a.array instanceof Float32Array) return;
  const f = new Float32Array(a.count);
  for (let i = 0; i < a.count; i++) f[i] = a.getX(i);
  geometry.setAttribute(name, new THREE.BufferAttribute(f, 1));
}
