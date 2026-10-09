// 車の中（窓枠の柱・ダッシュボード・座席・ドア・ボンネット）を、箱だけで作る。
// 座標は車の真ん中の地面が原点。+x = 右、+y = 上、-z = 前。小型車くらいの大きさ。
// 窓ガラスは無い（透明）。目の位置は SEATS から選ぶ。
// 地面が透けて見える隙間が無いよう、ドア・ボンネット・後ろは地面まで届く箱で埋めてある。
// 描く数を減らすため、全部の箱を 1 つの形にまとめ（色は頂点の色）、軽い材質で描く。
// 街とは別の場面として、街の描画のあとに重ね描きする（街の遠近の精度に影響しない）。
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** 座席ごとの目の位置（車の座標） */
export const SEATS = {
  driver: { label: "運転席", x: 0.36, y: 1.2, z: 0.14 },
  passenger: { label: "助手席", x: -0.36, y: 1.2, z: 0.14 },
  rearRight: { label: "後席(右)", x: 0.36, y: 1.16, z: 1.12 },
  rearLeft: { label: "後席(左)", x: -0.36, y: 1.16, z: 1.12 },
} as const;
export type SeatId = keyof typeof SEATS;

/** 全体の明るさ（トーンマップで暗くなる分を補う） */
const BRIGHT = 1.9;

function buildGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const put = (g: THREE.BufferGeometry, color: number, mat: THREE.Matrix4) => {
    g.applyMatrix4(mat);
    g.deleteAttribute("uv");
    // 光源は使わず、面の向きで明るさを決めておく（上向きは明るく、横は暗め）
    const c = new THREE.Color(color);
    const n = g.getAttribute("position").count;
    const nor = g.getAttribute("normal");
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ny = nor ? nor.getY(i) : 0, nz = nor ? nor.getZ(i) : 0;
      const k = BRIGHT * (0.62 + 0.3 * Math.max(ny, 0) - 0.18 * Math.max(-ny, 0) + 0.08 * nz);
      arr[i * 3] = c.r * k; arr[i * 3 + 1] = c.g * k; arr[i * 3 + 2] = c.b * k;
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    q.setFromEuler(e.set(rx, ry, rz));
    put(new THREE.BoxGeometry(w, h, d), color, m4.compose(new THREE.Vector3(x, y, z), q, one));
  };
  /** 2 点をつなぐ棒（柱） */
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number, d: number, color: number) => {
    const dir = b.clone().sub(a);
    const len = dir.length();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    put(new THREE.BoxGeometry(w, len, d), color, m4.compose(a.clone().add(b).multiplyScalar(0.5), q, one));
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const DARK = 0x4a4d55, DARKER = 0x2a2c31, TRIM = 0x8a8e96, LINER = 0xc9c7bd, SEAT = 0x5c6577, BODY = 0xd5d9dd, CARPET = 0x3a3b40;

  // 描く順番は「奥 → 手前」（奥行きの比較を使わないため）: 車体の箱 → ダッシュボード → ドア → 柱・天井 → 座席
  // 前: ボンネット（地面まで届く箱）
  box(1.64, 0.9, 1.65, BODY, 0, 0.45, -1.93);
  // 後ろ: 荷室（地面まで届く箱）
  box(1.64, 0.94, 0.9, BODY, 0, 0.47, 2.35);
  // 床
  box(1.64, 0.05, 3.2, CARPET, 0, 0.27, 0.5);
  // ダッシュボード
  box(1.64, 0.82, 0.5, DARK, 0, 0.41, -0.95);
  box(1.64, 0.24, 0.5, DARK, 0, 0.78, -0.95);
  box(1.52, 0.05, 0.5, DARKER, 0, 0.92, -0.93, 0.08); // 上の面（少し手前へ傾ける）
  box(0.5, 0.12, 0.26, DARKER, 0.36, 1.0, -0.84); // メーターのひさし
  box(1.64, 0.09, 0.1, DARKER, 0, 0.95, -1.18); // ガラスの下の黒い帯
  // 後ろの壁と棚
  box(1.64, 0.94, 0.12, DARK, 0, 0.47, 1.9);
  box(1.5, 0.06, 0.4, DARKER, 0, 0.97, 1.95);
  box(0.22, 0.28, 1.2, DARK, 0, 0.42, 0.1); // センターコンソール

  for (const sx of [-1, 1]) {
    // 横のドア（地面まで届く）。窓の下から下は全部ふさぐ
    box(0.12, 0.94, 2.95, DARK, sx * 0.8, 0.47, 0.375);
    box(0.13, 0.04, 2.95, TRIM, sx * 0.8, 0.96, 0.375); // 窓の下枠
  }
  for (const sx of [-1, 1]) {
    // 窓枠: A ピラー、屋根のふち、B ピラー、C ピラー
    bar(V(sx * 0.8, 0.93, -1.1), V(sx * 0.66, 1.52, -0.28), 0.09, 0.075, DARK);
    box(0.07, 0.07, 2.05, DARK, sx * 0.745, 1.52, 0.78);
    box(0.09, 0.97, 0.13, DARK, sx * 0.79, 1.04, 0.55);
    bar(V(sx * 0.78, 0.93, 1.55), V(sx * 0.68, 1.52, 1.78), 0.09, 0.15, DARK);
    // ドアミラー
    box(0.06, 0.12, 0.2, BODY, sx * 0.98, 1.02, -0.62);
    box(0.17, 0.03, 0.03, DARKER, sx * 0.89, 0.97, -0.62);
  }
  box(1.5, 0.07, 0.14, DARK, 0, 1.5, -0.27); // フロントガラスの上の枠
  box(1.5, 0.07, 0.14, DARK, 0, 1.5, 1.78); // 後ろの窓の上の枠
  box(1.5, 0.05, 2.1, LINER, 0, 1.55, 0.78); // 天井
  // ルームミラー
  box(0.22, 0.07, 0.04, DARKER, 0, 1.38, -0.4);
  box(0.03, 0.12, 0.03, DARKER, 0, 1.45, -0.38);

  // 座席（いちばん手前）。奥の席から先に描く
  const seat = (x: number, z: number, withHead = true) => {
    box(0.5, 0.13, 0.5, SEAT, x, 0.52, z);
    box(0.5, 0.6, 0.12, SEAT, x, 0.86, z + 0.3, 0.12);
    if (withHead) box(0.26, 0.2, 0.1, SEAT, x, 1.27, z + 0.35);
  };
  seat(0.36, 1.25);
  seat(-0.36, 1.25);
  seat(0, 1.25, false);
  seat(0.36, 0.3);
  seat(-0.36, 0.3);

  return mergeGeometries(parts)!;
}

/**
 * 車の中。街と同じ場面に入れる。
 * 近くが切れないよう、目の位置を中心に K 倍に拡大して置く（拡大しても画面での見え方は変わらない）。
 * こうすると、街側のカメラの「近くを切る距離」(0.8 m) を変えずに済む。
 * 拡大すると地面に埋まって見えなくなるので、奥行きの比較は使わず、描く順番（奥 → 手前）で重ねる。
 */
export const INTERIOR_SCALE = 4;

export function createInterior() {
  const car = new THREE.Group();
  car.name = "car-interior";
  const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  mat.fog = false;
  mat.depthTest = false; // 街より手前に描く
  mat.depthWrite = true; // 暗がりの計算が奥行きを読むので、書き込みだけは行う
  const mesh = new THREE.Mesh(buildGeometry(), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  car.add(mesh);
  car.visible = false;
  return {
    car,
    /** 車の位置・向き・目の位置（車の座標）から、拡大した車の置き場所を決める */
    place(carX: number, carZ: number, yaw: number, eye: THREE.Vector3Like, eyeWorld: THREE.Vector3Like) {
      const k = INTERIOR_SCALE;
      void eye;
      car.scale.setScalar(k);
      car.rotation.set(0, yaw, 0);
      car.position.set(k * carX + (1 - k) * eyeWorld.x, (1 - k) * eyeWorld.y, k * carZ + (1 - k) * eyeWorld.z);
    },
  };
}
