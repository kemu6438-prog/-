// 車の中（窓枠の柱・ダッシュボード・ハンドル・座席・ドア・ボンネット）を、箱と筒で作る。
// 座標は車の真ん中の地面が原点。+x = 右、+y = 上、-z = 前。右ハンドルの小型車くらいの大きさ。
// 窓ガラスは無い（透明）。目の位置は SEATS から選ぶ。
import * as THREE from "three/webgpu";

/** 座席ごとの目の位置（車の座標） */
export const SEATS = {
  driver: { label: "運転席", x: 0.36, y: 1.2, z: 0.14 },
  passenger: { label: "助手席", x: -0.36, y: 1.2, z: 0.14 },
  rearRight: { label: "後席(右)", x: 0.36, y: 1.16, z: 1.12 },
  rearLeft: { label: "後席(左)", x: -0.36, y: 1.16, z: 1.12 },
} as const;
export type SeatId = keyof typeof SEATS;

export function createCarInterior(): THREE.Group {
  const car = new THREE.Group();
  car.name = "car-interior";
  const mat = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const dark = mat(0x23252a, 0.82);
  const darker = mat(0x16171a, 0.9);
  const trim = mat(0x5b5f66, 0.55, 0.25);
  const liner = mat(0xb9b7ad, 0.95);
  const seatM = mat(0x3b414d, 0.95);
  const bodyM = mat(0xe6e8ea, 0.32, 0.45);
  const carpet = mat(0x1d1e21, 1.0);

  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    car.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    add(new THREE.BoxGeometry(w, h, d), m, x, y, z, rx, ry, rz);
  /** 2 点をつなぐ棒（柱） */
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number, d: number, m: THREE.Material) => {
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), m);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    car.add(mesh);
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // 床と、ほかの座席の足もと
  box(1.5, 0.05, 3.0, carpet, 0, 0.27, 0.55);
  box(0.22, 0.28, 1.2, dark, 0, 0.42, 0.1); // センターコンソール

  // ダッシュボードとボンネット
  box(1.52, 0.3, 0.45, dark, 0, 0.75, -0.95);
  box(1.52, 0.05, 0.5, darker, 0, 0.92, -0.93, 0.08); // 上の面（少し手前へ傾ける）
  box(0.5, 0.12, 0.26, darker, 0.36, 1.0, -0.84); // メーターのひさし
  box(1.46, 0.05, 1.5, bodyM, 0, 0.89, -1.95, -0.05); // ボンネット
  box(1.1, 0.09, 0.1, darker, 0, 0.95, -1.18); // ワイパー根もと（ガラスの下の黒い帯）

  // ハンドル（運転席の前）
  {
    const g = new THREE.Group();
    g.position.set(0.36, 0.86, -0.5);
    g.rotation.x = -0.5;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.02, 8, 28), darker);
    g.add(ring);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12), darker);
    hub.rotation.x = Math.PI / 2;
    g.add(hub);
    for (const [w, h, x, y] of [[0.34, 0.026, 0, 0], [0.026, 0.17, 0, -0.085]] as const) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.026), darker);
      sp.position.set(x, y, 0);
      g.add(sp);
    }
    car.add(g);
    // ハンドルの軸
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), darker, 0.36, 0.78, -0.62, 1.0);
  }

  // 窓枠: フロントガラスの柱（A ピラー）と上の枠
  for (const sx of [-1, 1]) {
    bar(V(sx * 0.8, 0.93, -1.1), V(sx * 0.66, 1.52, -0.28), 0.09, 0.075, dark);
    // 横の窓の枠: 屋根のふち、B ピラー、C ピラー
    box(0.07, 0.07, 2.05, dark, sx * 0.745, 1.52, 0.78);
    box(0.09, 0.97, 0.13, dark, sx * 0.79, 1.04, 0.55);
    bar(V(sx * 0.78, 0.93, 1.55), V(sx * 0.68, 1.52, 1.78), 0.09, 0.15, dark);
    // ドアの内側（窓の下）と、窓の下枠
    box(0.1, 0.42, 1.25, dark, sx * 0.8, 0.72, -0.08);
    box(0.1, 0.42, 1.0, dark, sx * 0.8, 0.72, 1.1);
    box(0.13, 0.04, 2.5, trim, sx * 0.78, 0.94, 0.55);
    // ドアミラー
    box(0.06, 0.12, 0.2, bodyM, sx * 0.98, 1.02, -0.62);
    box(0.17, 0.03, 0.03, darker, sx * 0.89, 0.97, -0.62);
  }
  box(1.5, 0.07, 0.14, dark, 0, 1.5, -0.27); // フロントガラスの上の枠
  box(1.5, 0.07, 0.14, dark, 0, 1.5, 1.78); // 後ろの窓の上の枠
  box(1.5, 0.05, 2.1, liner, 0, 1.55, 0.78); // 天井
  box(1.5, 0.06, 0.4, dark, 0, 0.97, 1.95); // 後ろの棚
  // ルームミラー
  box(0.22, 0.07, 0.04, darker, 0, 1.38, -0.4);
  box(0.03, 0.12, 0.03, darker, 0, 1.45, -0.38);

  // 座席
  const seat = (x: number, z: number, withHead = true) => {
    box(0.5, 0.13, 0.5, seatM, x, 0.52, z);
    box(0.5, 0.6, 0.12, seatM, x, 0.86, z + 0.3, 0.12);
    if (withHead) box(0.26, 0.2, 0.1, seatM, x, 1.27, z + 0.35);
  };
  seat(0.36, 0.3);
  seat(-0.36, 0.3);
  seat(0.36, 1.25);
  seat(-0.36, 1.25);
  seat(0, 1.25, false);

  return car;
}
