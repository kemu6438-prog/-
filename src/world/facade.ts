// LOD1 の建物（のっぺりした箱）を、窓・階・屋根・建物ごとの色で「建物らしく」塗るシェーダー。
// 画風の方針: 色は鮮やか寄りのやわらかいパステル、光はリアル寄り（MHST3 を目標にした絵作り）。
// 実装は three の TSL（WebGPU と WebGL 2 の両方で動くシェーダー言語）。
import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, cross, dFdx, dFdy, dot, float, floor,
  fract, length, max, min, mix, normalize, positionView, positionWorld, sign, smoothstep, step, vec2, vec3, viewportSize,
} from "three/tsl";
import { hash21, vnoise, type N } from "../render/noise";
import { TEX } from "../render/assets";

/** 0〜1 の疑似乱数（建物 ID 用） */
const hash = (x: N): N => fract(x.mul(12.9898).add(78.233).sin().mul(43758.5453));

type Out = { color: N; roughness: N; metalness: N; normal: N };

/** x が w より小さい所を 1 にする線（step の縁をなめらかにしたもの）。a は 1 画素ぶんの x の大きさ */
const lineLt = (x: N, w: number, a: N): N => float(1.0).sub(smoothstep(float(w).sub(a), float(w).add(a), x));

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
function buildLook(idRaw: N): Out {
  // 建物 ID は頂点の間で補間されるので、ごくわずかな誤差が出る。乱数は誤差に敏感なので、整数に丸めてから使う（これが無いと壁が砂嵐のようにちらつく）
  const id: N = idRaw.add(0.5).floor();
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
  // 地上（カメラが低い）のときだけ、カメラより高いところほど少しずつ簡単な塗りにする（4m から始まり 260m でゆっくり最大になる。最大でも窓はうっすら残る。上空からは普通に描く）
  const street: N = float(1.0).sub(smoothstep(20.0, 70.0, (cameraPosition as N).y));
  const upper: N = street.mul(smoothstep(4.0, 260.0, y.sub((cameraPosition as N).y)));
  // 高層ビルのいちばん上のほう（100m〜220m）は、さらに少し簡単にする（完全には消さず、窓がうっすら残る）
  const topFlat: N = smoothstep(100.0, 220.0, y);
  const simple: N = clamp(upper.mul(0.7).add(topFlat.mul(0.3)), 0.0, 1.0);
  // 1 画素ぶんの大きさ（マス 1 つに対する割合）を、横と縦で別々に求める。斜めから見ても縦方向はくっきり、横方向だけぼかす。
  // 画面上の変化量（dFdx）が使えない面の境目の画素では値が暴れるので、計算で求めた上限（pw）で抑える
  const fpU: N = min((abs(dFdx(u)) as N).add(abs(dFdy(u)) as N), pw.div(bayW)).max(0.0005);
  const fpV: N = min((abs(dFdx(v)) as N).add(abs(dFdy(v)) as N), pw.div(floorH)).max(0.0005);
  const fp0: N = max(fpU, fpV);
  // 簡単にするぶん、1 ピクセルが大きいことにして、窓が平らな色にとけるようにする
  const fp: N = fp0.add(simple.mul(0.11));
  const fpUs: N = fpU.add(simple.mul(0.11));
  const fpVs: N = fpV.add(simple.mul(0.11));
  const edge = (e: N, x: N): N => smoothstep(e.sub(fp), e.add(fp), x);
  const edgeU = (e: N, x: N): N => smoothstep(e.sub(fpUs), e.add(fpUs), x);
  const edgeV = (e: N, x: N): N => smoothstep(e.sub(fpVs), e.add(fpVs), x);
  // 壁の凹凸（光の当たり方）は、画面の変化量から作るので、遠くでは粗くなってちかちかする。かなり近いときだけ効かせる
  const bumpK: N = float(1.0).sub(smoothstep(0.005, 0.016, fp));
  const far: N = smoothstep(0.05, 0.17, fp);
  const near: N = float(1.0).sub(smoothstep(0.03, 0.12, fp));
  // 細い枠・桟は、1 ピクセルより細くなったらすぐ消す（白いちらつきの原因）
  const crisp: N = float(1.0).sub(smoothstep(0.012, 0.045, fp));
  // すぐ目の前（約 10m 以内）だけの、さらに細かい質感
  const close: N = float(1.0).sub(smoothstep(0.004, 0.02, fp));
  const isGround: N = float(1.0).sub(step(1.0, v));

  // --- 窓の形（種類ごと） ---
  const l0: N = pick(s, [0.2, 0.0, 0.04, 0.22, 0.3, 0.4]);
  const r0: N = pick(s, [0.8, 1.0, 0.96, 0.78, 0.7, 0.6]);
  const b0: N = pick(s, [0.34, 0.34, 0.06, 0.3, 0.34, 0.1]);
  const t0: N = pick(s, [0.78, 0.76, 0.94, 0.8, 0.74, 0.9]);
  // 1 階は店先の広いガラス（ガラスの建物は全部ガラスのまま）
  const shop: N = isGround.mul(step(s, 1.5).max(step(2.5, s)));
  const l: N = mix(l0, float(0.07), shop);
  const r: N = mix(r0, float(0.93), shop);
  const b: N = mix(b0, float(0.12), shop);
  const t: N = mix(t0, float(0.68), shop);
  const win: N = edgeU(l, fu).mul(float(1.0).sub(edgeU(r, fu))).mul(edgeV(b, fv)).mul(float(1.0).sub(edgeV(t, fv)));
  // 連続窓・カーテンウォールの縦の桟（細い線）
  const isBand: N = step(0.5, s).mul(step(s, 2.5));
  const mull: N = float(1.0).sub(isBand.mul(float(1.0).sub(edgeU(float(0.06), fu)).mul(crisp).mul(0.9)));
  // --- 窓の数を減らす: ふつうの壁の柱（階段室など）と、窓のないマス ---
  const isCW: N = step(1.5, s).mul(step(s, 2.5));
  const iu: N = floor(u);
  const colId: N = iu.add(floor(h2.mul(7.0)));
  const period: N = floor(h3.mul(2.999)).add(2.0);
  // 低層階（1〜5 階）は窓をだいぶ減らして、ただの壁を多くする
  const lowF: N = float(1.0).sub(smoothstep(1.5, 5.5, v));
  const periodW: N = mix(mix(period, period.mul(3.0), isBand), mix(float(2.0), float(3.0), isBand), lowF);
  const solidCol: N = step(fract(colId.div(periodW)), float(0.5).div(periodW));
  const wb: N = hash21(vec2(iu, floor(v)).add(vec2(h2.mul(31.0).add(7.3), h1.mul(19.0).add(3.1))));
  const blank: N = step(mix(float(0.86), float(0.4), lowF), wb).mul(float(1.0).sub(isCW));
  const shopOpen: N = step(0.3, hash(colId.add(h1.mul(59.0)).add(11.0)));
  const openCell: N = max(float(1.0).sub(solidCol).mul(float(1.0).sub(blank)), shop.mul(shopOpen));
  const winM: N = win.mul(mull).mul(openCell);
  const outer: N = edgeU(l.sub(0.035), fu)
    .mul(float(1.0).sub(edgeU(r.add(0.035), fu)))
    .mul(edgeV(b.sub(0.03), fv))
    .mul(float(1.0).sub(edgeV(t.add(0.03), fv)));
  const frame: N = clamp(outer.sub(win), 0.0, 1.0).add(float(1.0).sub(mull).mul(win)).mul(crisp).mul(openCell);
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
  const winAmount0: N = mix(winM.mul(hasWindows), hasWindows.mul(mix(float(0.34), float(0.9), isCW)).mul(mix(float(0.75), float(1.0), isCW)).mul(float(1.0).sub(lowF.mul(0.5))), far);
  // 1 階の店先に、ときどきシャッター（閉店）
  const shutId: N = hash(floor(uMeters.div(3.4)).add(h2.mul(13.0)).add(3.0));
  const shutter: N = shop.mul(step(0.78, shutId)).mul(win).mul(wallMask);
  const winAmount: N = winAmount0.mul(float(1.0).sub(shutter));

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
  const mott: N = vnoise(surf.mul(0.3)).mul(0.5).add(vnoise(surf.mul(1.3)).mul(0.3)).add(vnoise(surf.mul(6.0)).mul(0.2).mul(close));
  const mottle: N = float(0.86).add(mott.mul(0.28).mul(float(1.0).sub(simple.mul(0.7))));
  const streak: N = vnoise(vec2(uMeters.mul(1.5), floor(v).mul(3.1))).mul(float(1.0).sub(fv)).mul(0.2).mul(near).mul(wallMask);

  // レンガ・石の目地（近いときだけ）
  const brickFade: N = float(1.0).sub(smoothstep(0.03, 0.14, pw));
  const row: N = floor(y.div(0.075));
  const bx: N = fract(uMeters.div(0.25).add(row.mul(0.5)));
  const brickLine: N = max(lineLt(bx, 0.05, pw.div(0.25)), lineLt(fract(y.div(0.075)), 0.1, pw.div(0.075))).mul(brickFade);
  const stoneRow: N = floor(y.div(0.45));
  const sx: N = fract(uMeters.div(0.9).add(stoneRow.mul(0.37)));
  const stoneLine: N = max(lineLt(sx, 0.025, pw.div(0.9)), lineLt(fract(y.div(0.45)), 0.04, pw.div(0.45))).mul(float(1.0).sub(smoothstep(0.05, 0.25, pw)));
  const mortar: N = brickLine.mul(step(3.5, s).mul(step(s, 4.5))).mul(float(1.0).sub(TEX.brick.on)).add(stoneLine.mul(step(4.5, s))).mul(0.22);

  // 集合住宅: ベランダ（手すりと床の出っぱり）と、縦縞の色パネル
  const isDwell: N = step(2.5, s).mul(step(s, 3.5));
  const rail: N = isDwell.mul(float(1.0).sub(edgeV(float(0.24), fv))).mul(edgeV(float(0.05), fv)).mul(near);
  const slabLine: N = isDwell.mul(float(1.0).sub(edgeV(float(0.05), fv))).mul(near);
  const panel: N = isDwell.mul(step(0.5, fract(floor(u).mul(0.5).add(h2)))).mul(0.12);

  // 床の継ぎ目・ひさし・窓の下の影
  const slab: N = float(1.0).sub(float(1.0).sub(edgeV(float(0.07), fv)).mul(0.16).mul(near));
  const sill: N = float(1.0).sub(edgeV(float(0.3), fv).mul(float(1.0).sub(edgeV(float(0.36), fv))).mul(0.22).mul(near).mul(float(1.0).sub(isDwell)));
  const cornice: N = float(1.0).add(edgeV(float(0.93), fv).mul(0.07).mul(near));
  const grounded: N = mix(float(0.7), float(1.0), smoothstep(0.0, 14.0, y));

  // ネットの素材（読み込めたら）: 壁・屋根はコンクリートの肌、レンガの壁は本物のレンガ模様
  const isBrickS: N = step(3.5, s).mul(step(s, 4.5));
  const concreteD: N = TEX.wall.detail(surf);
  const brickD: N = TEX.brick.detail(vec2(uMeters, y));
  const detailK: N = float(1.0).sub(simple);
  // 近いほど壁の質感を少しはっきり（コントラストを上げる）、簡単にする所は平らに
  const grain: N = float(1.0).add(vnoise(surf.mul(18.0)).sub(0.5).mul(0.22).mul(close));
  const baseD: N = concreteD;
  const texD: N = mix(mix(vec3(1, 1, 1), baseD, mix(0.2, mix(0.75, 0.95, close), detailK)), brickD, isBrickS.mul(wallMask).mul(detailK)).mul(grain);
  let wallBody: N = wallBase.mul(texD).mul(slab).mul(sill).mul(cornice).mul(mottle).mul(float(1.0).sub(streak)).mul(float(1.0).sub(panel)).mul(float(1.0).sub(mortar));
  wallBody = mix(wallBody, vec3(0.3, 0.32, 0.34), rail.mul(0.85));
  wallBody = mix(wallBody, wallBody.mul(0.65), slabLine);
  const sash: N = vec3(0.7, 0.7, 0.68);
  wallBody = mix(wallBody, sash, frame.mul(hasWindows).mul(0.6).mul(step(s, 1.5).max(step(2.5, s)).max(0.4)));

  // 1 階の看板と、ひさし
  const signBand: N = shop.mul(edgeV(float(0.76), fv)).mul(float(1.0).sub(edgeV(float(0.97), fv)));
  const signId: N = floor(uMeters.div(5.0)).add(h1.mul(31.0));
  const sh: N = hash(signId);
  const signCol: N = mix(mix(vec3(0.85, 0.15, 0.15), vec3(0.95, 0.8, 0.15), step(0.33, sh)), mix(vec3(0.15, 0.4, 0.8), vec3(0.2, 0.55, 0.35), step(0.8, sh)), step(0.66, sh));
  const letters: N = step(0.5, vnoise(vec2(uMeters.mul(2.4), 0.0)).add(0.0)).mul(near);
  const hasSign: N = step(0.4, hash(signId.add(5.0)));
  const signColor: N = mix(signCol, vec3(0.97, 0.97, 0.95), letters.mul(0.55));
  wallBody = mix(wallBody, signColor, signBand.mul(hasSign).mul(near).mul(float(1.0).sub(step(1.5, s).mul(step(s, 2.5)))));
  const awningColor: N = mix(vec3(0.75, 0.3, 0.28), vec3(0.28, 0.5, 0.45), step(0.5, h1));
  const awning: N = shop.mul(edgeV(float(0.68), fv)).mul(float(1.0).sub(edgeV(float(0.76), fv))).mul(step(0.45, h2));
  wallBody = mix(wallBody, awningColor, awning.mul(near));

  // 2〜3 階あたりの縦型の突き出し看板（ときどき）
  const vId: N = floor(uMeters.div(4.0)).add(h2.mul(53.0));
  const vHas: N = step(0.9, hash(vId)).mul(step(1.0, v)).mul(step(v, 3.6)).mul(step(s, 4.5));
  const vx: N = fract(uMeters.div(4.0));
  const vBox: N = edge(float(0.82), vx).mul(float(1.0).sub(edge(float(0.94), vx))).mul(vHas).mul(near).mul(wallMask);
  const vCol: N = mix(mix(vec3(0.9, 0.12, 0.12), vec3(0.95, 0.85, 0.1), step(0.33, hash(vId.add(1.0)))), vec3(0.15, 0.45, 0.85), step(0.66, hash(vId.add(1.0))));
  const vStripe: N = smoothstep(float(0.5).sub(pw.mul(1.4)), float(0.5).add(pw.mul(1.4)), fract(y.mul(1.4)));
  wallBody = mix(wallBody, mix(vCol, vec3(0.97, 0.97, 0.95), vStripe.mul(0.7)), vBox);

  // --- 壁の細部（配管・柱型のでっぱり・室外機・パネルの目地）。窓が減ったぶん、ふつうの壁に情報を足す ---
  const dpx: N = float(0.5).sub(abs(fu.sub(0.5))); // マスの縁までの距離（縁で 0）
  const notBand: N = float(1.0).sub(isBand);
  // 縦の配管（ときどき）
  const pipeCol: N = step(0.8, hash(colId.add(h1.mul(91.0))));
  const crispP: N = float(1.0).sub(smoothstep(0.02, 0.09, fp));
  const pipe: N = float(1.0).sub(edgeU(float(0.018), dpx)).mul(pipeCol).mul(notBand).mul(crispP).mul(wallMask);
  wallBody = mix(wallBody, vec3(0.3, 0.31, 0.33).mul(mix(float(0.8), float(1.2), step(0.5, fu))), pipe.mul(0.9));
  // 柱型（縦のでっぱり）: 左は明るく、右は影
  const ribOn: N = step(0.45, h1).mul(step(s, 0.5).max(step(3.5, s)));
  const ribW: N = float(1.0).sub(edgeU(float(0.07), dpx));
  const ribLine: N = float(1.0).sub(edgeU(float(0.012), dpx));
  const ribK: N = ribOn.mul(near).mul(wallMask).mul(notBand);
  wallBody = wallBody.mul(float(1.0).add(ribW.mul(ribK).mul(float(0.12).sub(step(0.5, fu).mul(0.2))))).mul(float(1.0).sub(ribLine.mul(ribK).mul(0.25)));
  // エアコンの室外機（ときどき）
  const acOn: N = step(0.9, hash21(vec2(iu, floor(v)).add(vec2(h3.mul(43.0).add(5.0), h1.mul(71.0).add(1.0))))).mul(openCell).mul(float(1.0).sub(isGround)).mul(notBand);
  const acBox: N = edgeU(float(0.56), fu).mul(float(1.0).sub(edgeU(float(0.86), fu))).mul(edgeV(float(0.03), fv)).mul(float(1.0).sub(edgeV(float(0.2), fv)));
  const fan: N = float(1.0).sub(smoothstep(0.65, 0.95, length(vec2(fu.sub(0.71).div(0.12), fv.sub(0.115).div(0.06)))));
  wallBody = mix(wallBody, mix(vec3(0.82, 0.83, 0.84), vec3(0.2, 0.21, 0.22), fan), acOn.mul(acBox).mul(near).mul(wallMask));
  // 外壁パネルの目地（事務所・連続窓の建物）
  const tj: N = fract(uMeters.div(1.2));
  const jointU: N = lineLt(min(tj, float(1.0).sub(tj)), 0.007, pw.div(1.2));
  const tk: N = fract(y.div(0.9));
  const jointV: N = lineLt(min(tk, float(1.0).sub(tk)), 0.01, pw.div(0.9));
  wallBody = wallBody.mul(float(1.0).sub(max(jointU, jointV).mul(step(s, 1.5)).mul(close).mul(wallMask).mul(0.22)));

  // 波板のシャッター: 縦のすじ（細かすぎる所はならして平らに）
  const rib9: N = float(0.9).add(smoothstep(0.35, 0.65, abs(fract(uMeters.mul(8.0)).sub(0.5)).mul(2.0)).mul(0.14).mul(near));
  const shutterCol: N = vec3(0.62, 0.64, 0.66).mul(rib9).mul(float(0.92).add(h3.mul(0.14)));
  const wallColor: N = mix(mix(wallBody, glassColor, winAmount), shutterCol, shutter).mul(grounded);

  // --- 壁の凹凸（光の当たり方だけで見せる: 窓のへこみ・柱型・床のでっぱり・配管・室外機・波板） ---
  const slabLedge: N = float(1.0).sub(edgeV(float(0.06), fv)).mul(float(1.0).sub(isCW)).mul(notBand);
  const plinth: N = smoothstep(0.7, 0.4, y);
  const hgt: N = ribW.mul(ribK).mul(0.1)
    .sub(winAmount.mul(0.12))
    .add(slabLedge.mul(0.05))
    .add(pipe.mul(0.07))
    .add(acOn.mul(acBox).mul(0.25))
    .add(plinth.mul(0.05))
    .add(shutter.mul(abs(fract(uMeters.mul(8.0)).sub(0.5)).mul(0.03)))
    .mul(bumpK).mul(wallMask);
  const sX: N = dFdx(pv) as N;
  const sY: N = dFdy(pv) as N;
  const r1: N = cross(sY, faceV);
  const r2: N = cross(faceV, sX);
  const det: N = dot(sX, r1);
  const grad: N = sign(det).mul((dFdx(hgt) as N).mul(r1).add((dFdy(hgt) as N).mul(r2)));
  const bumped: N = normalize(abs(det).mul(faceV).sub(grad.mul(1.5)));
  const normal: N = normalize(mix(faceV, bumped, bumpK.mul(wallMask)) as N);

  // --- 屋根 ---
  const roofGrey: N = mix(vec3(0.5, 0.52, 0.54), vec3(0.45, 0.53, 0.48), step(0.55, h2));
  const roofBase: N = mix(roofGrey, vec3(0.62, 0.34, 0.27), step(0.94, h2)).mul(float(0.85).add(h3.mul(0.2)));
  const rp: N = vec2(positionWorld.x, positionWorld.z);
  const seam: N = max(lineLt(fract(rp.x.div(6.0)), 0.012, pw.div(6.0)), lineLt(fract(rp.y.div(6.0)), 0.012, pw.div(6.0))).mul(float(1.0).sub(smoothstep(0.05, 0.3, pw))).mul(0.18);
  const roofColor: N = roofBase.mul(mix(vec3(1, 1, 1), concreteD, 0.8)).mul(float(0.8).add(vnoise(rp.mul(0.7)).mul(0.4))).mul(float(0.92).add(vnoise(rp.mul(5.0)).mul(0.16).mul(near))).mul(float(1.0).sub(seam));

  // --- つや: 壁・屋根はざらざら、ガラスはつるつる＋映り込み ---
  const isCurtainWall: N = isCW;
  const glassRough: N = mix(mix(float(0.07), float(0.04), isCurtainWall), float(0.7), curtain);
  const roughness: N = mix(float(0.9), mix(float(0.88), glassRough, winAmount), wallMask);
  const metalness: N = winAmount.mul(float(1.0).sub(curtain)).mul(mix(float(0.55), float(0.8), isCurtainWall)).mul(wallMask);

  const outc: N = mix(roofColor, wallColor, wallMask);
  return { color: outc, roughness, metalness, normal };
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
  m.normalNode = look.normal;
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
