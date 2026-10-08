// 地球上の位置（緯度・経度・高さ）と、画面で使うローカル座標を行き来する計算。
// 純粋な計算だけ（画面や three.js に依存しない部分は単体テストできる）。
import { Matrix4, Vector3 } from "three";

const A = 6378137; // WGS84 長半径
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export type Geodetic = { lat: number; lon: number; h: number };

/** 緯度・経度・楕円体高 → 地球中心座標 (ECEF, m) */
export function geodeticToEcef(lat: number, lon: number, h: number): Vector3 {
  const phi = lat * DEG;
  const lam = lon * DEG;
  const sp = Math.sin(phi);
  const n = A / Math.sqrt(1 - E2 * sp * sp);
  return new Vector3(
    (n + h) * Math.cos(phi) * Math.cos(lam),
    (n + h) * Math.cos(phi) * Math.sin(lam),
    (n * (1 - E2) + h) * sp,
  );
}

/** 地球中心座標 → 緯度・経度・楕円体高 */
export function ecefToGeodetic(x: number, y: number, z: number): Geodetic {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const sp = Math.sin(phi);
    const n = A / Math.sqrt(1 - E2 * sp * sp);
    h = p / Math.cos(phi) - n;
    phi = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: phi / DEG, lon: lon / DEG, h };
}

/**
 * ある地点を原点にした画面用の座標系。x=東、y=上、-z=北。
 * （3Dの世界では、地球中心座標のままだと数字が大きすぎて揺れるので、
 *   自分の近くを原点にし直して使う。これを「浮動原点」と呼ぶ）
 */
export class LocalFrame {
  readonly ecefToLocal = new Matrix4();
  readonly localToEcef = new Matrix4();

  constructor(readonly origin: Geodetic) {
    const phi = origin.lat * DEG;
    const lam = origin.lon * DEG;
    const sp = Math.sin(phi), cp = Math.cos(phi), sl = Math.sin(lam), cl = Math.cos(lam);
    const o = geodeticToEcef(origin.lat, origin.lon, origin.h);
    const east = [-sl, cl, 0];
    const up = [cp * cl, cp * sl, sp];
    const south = [sp * cl, sp * sl, -cp]; // -北 = z 軸
    const t = (r: number[]) => -(r[0] * o.x + r[1] * o.y + r[2] * o.z);
    this.ecefToLocal.set(
      east[0], east[1], east[2], t(east),
      up[0], up[1], up[2], t(up),
      south[0], south[1], south[2], t(south),
      0, 0, 0, 1,
    );
    this.localToEcef.copy(this.ecefToLocal).invert();
  }

  toLocal(lat: number, lon: number, h: number, target = new Vector3()): Vector3 {
    return target.copy(geodeticToEcef(lat, lon, h)).applyMatrix4(this.ecefToLocal);
  }

  toGeodetic(local: Vector3): Geodetic {
    const p = local.clone().applyMatrix4(this.localToEcef);
    return ecefToGeodetic(p.x, p.y, p.z);
  }
}
