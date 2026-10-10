// 地面の材質（道路の外の地面）。基本はコンクリートと砂利の簡易な見た目。
// 航空写真が読み込めたら、写真の色に切り替わる（photoGround.ts が写真の材料を渡す）。
// 近く・中くらい・遠くの 3 枚で、まったく同じ作り方（同じシェーダー）を使い回す。
import * as THREE from "three/webgpu";
import { float, mix, positionWorld, smoothstep, vec2, vec3 } from "three/tsl";
import { TEX } from "./assets";
import { vnoise, type N } from "./noise";

/** 地面 1 枚分の「写真」の受け口（photoGround が用意する）。on が 0 → 簡易な色、1 → 写真 */
export type GroundPhoto = { on: N; colorNode: N };

export function makeGroundMaterial(photo?: GroundPhoto): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  const p: N = vec2(positionWorld.x, positionWorld.z);
  // 簡易な見た目: 明るめのコンクリートと砂利のむら。道路そのものは roads.ts の専用の面で描くので、ここは「道路以外」の色
  const n2: N = vnoise(p.mul(0.35));
  const lot: N = mix(vec3(0.42, 0.41, 0.39), vec3(0.54, 0.52, 0.48), n2)
    .mul(float(0.92).add(n2.mul(0.16)));
  const procedural: N = lot.mul(TEX.concrete.detail(p)).mul(n2.mul(0.14).add(0.93));
  mat.colorNode = photo ? mix(procedural, photo.colorNode, photo.on) : procedural;
  // 影の中の明るさに、大きなむら（広場ごと・街区ごとの違い）
  mat.aoNode = mix(float(0.55), float(1.0), smoothstep(0.15, 0.85, vnoise(p.mul(0.021).add(vec2(37.0, 11.0)))));
  return mat;
}
