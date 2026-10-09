// LOD1 の建物（のっぺりした箱）を、窓・階・屋根・建物ごとの色で「建物らしく」塗るシェーダー。
// 画風の方針: 色は鮮やか寄りのやわらかいパステル、光はリアル寄り（MHST3 を目標にした絵作り）。
// 実装は three の TSL（WebGPU と WebGL 2 の両方で動くシェーダー言語）。
import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraProjectionMatrix, cameraViewMatrix, clamp, cross, dFdx, dFdy, dot, float, floor,
  fract, length, max, min, mix, normalize, positionView, positionWorld, smoothstep, step, texture, vec2, vec3, viewportSize,
} from "three/tsl";
import { vnoise, type N } from "../render/noise";
import { TEX } from "../render/assets";
import { ATLAS_H, BAYS, FLOORS, FLOOR_PX, GROUND_H, GUTTER, KIND_BLOCK, UPPER_BLOCK, UPPER_H, facadeAtlas } from "../render/facadeAtlas";

/** 0〜1 の疑似乱数（建物 ID 用） */
const hash = (x: N): N => fract(x.mul(12.9898).add(78.233).sin().mul(43758.5453));

type Out = { color: N; roughness: N; metalness: N; ao: N };

/** 番号(0..5)ごとの数値を選ぶ（s は 0〜5 の小数） */
const pick = (s: N, vals: number[]): N => {
  let r: N = float(vals[0]);
  for (let i = 1; i < vals.length; i++) r = mix(r, float(vals[i]), step(i - 0.5, s));
  return r;
};

/** 壁の色（種類 s ごと。建物ごとの乱数 h1〜h3 で少し変える）。近くの壁と遠くの壁で同じ色にするため、共通にしてある */
function wallBaseColor(s: N, h1: N, h2: N, h3: N): N {
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
  wallBase = mix(wallBase, vec3(0.78, 0.8, 0.84), step(1.5, s)); // ガラスの建物の壁（枠・腰壁）は明るい灰色
  wallBase = mix(wallBase, dwelling, step(2.5, s));
  wallBase = mix(wallBase, brickC, step(3.5, s));
  wallBase = mix(wallBase, stoneC, step(4.5, s));

  return wallBase;
}

/**
 * 外観の種類（s）:
 * 0 事務所ビル（格子の窓）/ 1 横長の連続窓 / 2 ガラスのカーテンウォール
 * 3 集合住宅（ベランダ）/ 4 レンガ・タイル張り / 5 石造り（縦長のスリット窓）
 *
 * 窓・桟・看板・配管などの細かい絵は、起動時に描いた 1 枚の画像（render/facadeAtlas.ts）から引く。
 * ここでは「どの建物がどの種類か」「建物ごとの壁の色・ガラスの色」「画像のどこを引くか」だけを計算する。
 */
function buildLook(idRaw: N): Out {
  // 建物 ID は頂点の間で補間されるので、ごくわずかな誤差が出る。乱数は誤差に敏感なので、整数に丸めてから使う
  const id: N = idRaw.add(0.5).floor();
  const h1 = hash(id);
  const h2 = hash(id.add(17.3));
  const h3 = hash(id.add(41.7));
  const hs = hash(id.add(77.7));

  // 高さ（ワールド座標の y）
  const y: N = positionWorld.y;

  // 外観の種類。高いところ(36m〜)は、低層向きの種類をやめて事務所・連続窓・ガラスにする（下が低層、上が高層）
  const s0: N = step(0.28, hs).add(step(0.46, hs)).add(step(0.54, hs)).add(step(0.76, hs)).add(step(0.92, hs));
  const sTall: N = mix(s0, step(0.45, h2).add(step(0.78, h2)), step(2.5, s0));
  const s: N = mix(s0, sTall, step(36.0, y));

  const bayW: N = pick(s, [3.4, 2.8, 1.8, 3.0, 3.2, 2.4]);
  const floorH: N = pick(s, [3.6, 3.8, 3.8, 3.0, 3.2, 3.6]);

  // --- 面の向き ---
  const pv: N = positionView as N;
  const faceV: N = normalize(cross(dFdx(pv) as N, dFdy(pv) as N));
  const faceD: N = faceV.transformNormalByInverseViewMatrix(cameraViewMatrix);
  // 壁か屋根か（0.5 の境目だけが問題なので、多少揺れても影響しない）
  const wallMask: N = step(abs(faceD.y), 0.5);
  // 壁の横方向の向き（読み込み時に頂点へ書き込んだ値。同じ壁ならどの頂点も同じなので揺れない）
  const tangent: N = attribute("wallT", "vec2") as unknown as N;
  // 1 ピクセルが現実で何メートルか（遠い・斜めほど大きい）。画像を引くときの変化量の上限に使う
  const dist: N = length(pv);
  const pixAngle: N = float(2.0).div((cameraProjectionMatrix as N).element(1).y.mul(viewportSize.y));
  const cosv: N = max(abs(dot(normalize(pv), faceV)), 0.12);
  const pw: N = dist.mul(pixAngle).div(cosv);

  // --- 画像のどこを引くか ---
  const uMeters: N = dot(vec2(positionWorld.x, positionWorld.z), tangent).add(h2.mul(37.0));
  const tileW: N = bayW.mul(BAYS).mul(h3.mul(0.3).add(0.85)); // 建物ごとにマスの幅を少し変える
  const u: N = uMeters.div(tileW);
  const isGround: N = float(1.0).sub(step(floorH, y)); // 1 階
  const fv: N = fract(y.sub(floorH).div(floorH.mul(FLOORS)));
  const vg: N = clamp(y.div(floorH), 0.0, 1.0);
  // 窓の量: 現実の建物は、窓がある面は一部で、多くの面は壁。窓のある面でも、窓は一か所に固まっている。
  // 面ごとに窓あり/なしを決める（同じ壁は同じ。向きで決めるので、反対側の壁も同じになる）。会社のビル（事務所の 2 割）は窓が多い
  const faceKey: N = floor(tangent.x.mul(4.0).add(0.5)).mul(13.1).add(floor(tangent.y.mul(4.0).add(0.5)).mul(7.7));
  const faceH: N = hash(id.mul(1.7).add(faceKey).add(3.3));
  const dense: N = step(0.8, hash(id.add(5.5))).mul(float(1.0).sub(step(0.5, s)));
  const notCurtain: N = float(1.0).sub(step(1.5, s).mul(step(s, 2.5)));
  const isBlank: N = step(faceH, 0.42).mul(notCurtain).mul(float(1.0).sub(dense));
  const blankKind: N = float(6.0).add(step(3.5, s)).add(step(4.5, s)); // 一般 6 / レンガ 7 / 石 8
  const sUp: N = mix(mix(s, blankKind, isBlank), float(9.0), dense);
  const kBase: N = s.mul(KIND_BLOCK);
  const kUp: N = sUp.mul(KIND_BLOCK);
  const rowUpper: N = kUp.add(GUTTER).add(float(1.0).sub(fv).mul(UPPER_H));
  const rowGround: N = kBase.add(UPPER_BLOCK + GUTTER).add(float(1.0).sub(vg).mul(GROUND_H));
  const row: N = mix(rowUpper, rowGround, isGround);
  const uv: N = vec2(u, float(1.0).sub(row.div(ATLAS_H)));
  // 引くときの「1 画素で画像のどれだけ動くか」は、継ぎ目（くり返しの切れ目・階の境目）で暴れないよう、
  // 連続な量（壁に沿った距離 uMeters と高さ y）から求めて、1 画素の実寸（pw）で上限をかける
  const lim = (v: N): N => clamp(v, pw.negate(), pw);
  const vk: N = float(FLOOR_PX / ATLAS_H).div(floorH);
  const gX: N = vec2(lim(dFdx(uMeters) as N).div(tileW), lim(dFdx(y) as N).mul(vk));
  const gY: N = vec2(lim(dFdy(uMeters) as N).div(tileW), lim(dFdy(y) as N).mul(vk));
  const tex = texture(facadeAtlas(), uv).grad(gX, gY) as unknown as N;
  const rgb: N = tex.rgb as N;
  const glass: N = (tex.a as N).mul(wallMask);

  // --- 壁の色（種類ごと） ---
  const wallBase: N = wallBaseColor(s, h1, h2, h3);

  // 画像の「ほぼ無彩色の所」だけに壁の色を掛ける（ガラス・看板・カーテンなど色のある所は、そのまま）
  const chroma: N = max(max(rgb.x, rgb.y), rgb.z).sub(min(min(rgb.x, rgb.y), rgb.z));
  const tintAmt: N = float(1.0).sub(smoothstep(0.05, 0.2, chroma)).mul(float(1.0).sub(glass));
  // ガラスの色は建物ごとに少し変える（青系・緑がかった系・暗い系）
  const glassTint: N = mix(mix(vec3(1.0, 1.0, 1.0), vec3(0.72, 1.12, 1.02), step(0.55, h1)), vec3(0.55, 0.62, 0.72), step(3.5, s))
    .mul(float(0.85).add(h2.mul(0.3)));
  const surf: N = vec2(uMeters, y);
  // 近くでだけ、壁の質感（ネットの素材）を重ねる
  const detailK: N = float(1.0).sub(smoothstep(25.0, 110.0, dist)).mul(0.8);
  const concreteD: N = TEX.wall.detail(surf);
  const mottle: N = float(0.9).add(vnoise(surf.mul(0.28)).mul(0.2));
  const grounded: N = mix(float(0.7), float(1.0), smoothstep(0.0, 14.0, y));
  const lit: N = mix(rgb.mul(mix(vec3(1.0, 1.0, 1.0), wallBase, tintAmt)), rgb.mul(glassTint), glass)
    .mul(mix(vec3(1.0, 1.0, 1.0), concreteD, detailK.mul(float(1.0).sub(glass))))
    .mul(mottle).mul(grounded);
  const wallColor: N = lit;

  // --- 屋根 ---
  const roofGrey: N = mix(vec3(0.5, 0.52, 0.54), vec3(0.45, 0.53, 0.48), step(0.55, h2));
  const roofBase: N = mix(roofGrey, vec3(0.62, 0.34, 0.27), step(0.94, h2)).mul(float(0.85).add(h3.mul(0.2)));
  const rp: N = vec2(positionWorld.x, positionWorld.z);
  const roofColor: N = roofBase.mul(mix(vec3(1, 1, 1), concreteD, 0.8)).mul(float(0.8).add(vnoise(rp.mul(0.7)).mul(0.4)));

  // --- つや: 壁はざらざら、ガラスはつるつる＋映り込み ---
  const isCurtainWall: N = step(1.5, s).mul(step(s, 2.5));
  const glassRough: N = mix(float(0.07), float(0.04), isCurtainWall);
  const roughness: N = mix(float(0.9), mix(float(0.88), glassRough, glass), wallMask);
  const metalness: N = glass.mul(mix(float(0.55), float(0.8), isCurtainWall)).mul(wallMask);

  const outc: N = mix(roofColor, wallColor, wallMask);
  // 影の濃淡: 空の光（影の中の明るさ）は、街の谷間の低い階ほど届かず、高い所ほどよく届く。建物ごとにも少し違う
  const ao: N = mix(float(0.42), float(1.0), smoothstep(0.0, 45.0, y)).mul(float(0.78).add(h3.mul(0.3)));
  return { color: outc, roughness, metalness, ao };
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
  m.aoNode = look.ao;
  // 建物データの読み込み側が、使い終わりの建物ごとに材質を dispose する。共有の材質を壊されると、次に使うとき重いシェーダーを作り直して画面が止まるので、無視する
  m.dispose = () => {};
  cache.set(key, m);
  return m;
}

const farCache = new Map<string, THREE.MeshStandardNodeMaterial>();

/**
 * 遠くの建物用の軽い材質。窓の画像・質感・つやなどは使わず、壁の色（近くと同じ）を平らに塗るだけにする。
 * 遠くは 1 画素に窓が何枚も入るので、窓の絵を引いても見た目はほとんど変わらず、計算だけが重い。
 */
export function farFacadeMaterial(idAttribute: string | null): THREE.MeshStandardNodeMaterial {
  const key = idAttribute ?? "(none)";
  let m = farCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, flatShading: true });
  const id0: N = idAttribute
    ? (attribute(idAttribute, "float") as unknown as N)
    : (positionWorld.x.div(22.0).floor().mul(7.0).add(positionWorld.z.div(22.0).floor().mul(131.0)) as unknown as N);
  const id: N = id0.add(0.5).floor();
  const h1 = hash(id), h2 = hash(id.add(17.3)), h3 = hash(id.add(41.7)), hs = hash(id.add(77.7));
  const y: N = positionWorld.y;
  const s0: N = step(0.28, hs).add(step(0.46, hs)).add(step(0.54, hs)).add(step(0.76, hs)).add(step(0.92, hs));
  const sTall: N = mix(s0, step(0.45, h2).add(step(0.78, h2)), step(2.5, s0));
  const s: N = mix(s0, sTall, step(36.0, y));
  const pv: N = positionView as N;
  const faceV: N = normalize(cross(dFdx(pv) as N, dFdy(pv) as N));
  const faceD: N = faceV.transformNormalByInverseViewMatrix(cameraViewMatrix);
  const wallMask: N = step(abs(faceD.y), 0.5);
  const isCurtain: N = step(1.5, s).mul(step(s, 2.5));
  // 窓のぶんだけ少し暗く（近くの壁の平均に合わせる）。ガラスの建物は青みがかった暗さ
  const base: N = wallBaseColor(s, h1, h2, h3);
  const wall: N = mix(base.mul(0.82), vec3(0.34, 0.42, 0.52), isCurtain.mul(0.7)).mul(mix(float(0.7), float(1.0), smoothstep(0.0, 14.0, y)));
  const roofGrey: N = mix(vec3(0.5, 0.52, 0.54), vec3(0.45, 0.53, 0.48), step(0.55, h2));
  const roof: N = mix(roofGrey, vec3(0.62, 0.34, 0.27), step(0.94, h2)).mul(float(0.85).add(h3.mul(0.2))).mul(0.85);
  m.colorNode = mix(roof, wall, wallMask);
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0.0);
  m.aoNode = mix(float(0.42), float(1.0), smoothstep(0.0, 45.0, y)).mul(float(0.78).add(h3.mul(0.3)));
  m.dispose = () => {};
  farCache.set(key, m);
  return m;
}

let prepass: THREE.MeshBasicNodeMaterial | null = null;
/**
 * 建物の「奥行きだけ」を先に描くための材質（色は描かない）。
 * 先に奥行きを描いておくと、重い壁の塗りは「実際に見える画素」にだけ実行される（高い建物がずらっと並ぶ通りで、壁の裏側や奥の建物を無駄に塗らない）。
 * 少しだけ奥にずらして描く（本番の描画が必ず通るように）。
 */
export function depthPrepassMaterial(): THREE.MeshBasicNodeMaterial {
  if (prepass) return prepass;
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorWrite = false;
  m.polygonOffset = true;
  m.polygonOffsetFactor = 2;
  m.polygonOffsetUnits = 4;
  m.dispose = () => {};
  prepass = m;
  return m;
}

let plain: THREE.MeshStandardMaterial | null = null;
/** 比較用の単色の壁（?facade=0）。凝った塗りを全部やめる */
export function plainMaterial(): THREE.MeshStandardMaterial {
  if (plain) return plain;
  const m = new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.9, metalness: 0 });
  m.dispose = () => {};
  plain = m;
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
