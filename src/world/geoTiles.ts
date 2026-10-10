// 地図タイル（ウェブメルカトル）の計算。純粋な計算だけ（画面・three.js に依存しないので単体テストできる）。
// 国土地理院のタイルも OpenStreetMap と同じ方式（左上が北西）。

/** 経度 → タイルの番号（西→東） */
export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/** 緯度 → タイルの番号（北→南） */
export function latToTileY(lat: number, z: number): number {
  const phi = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z);
}

/** タイルの番号（西端）→ 経度 */
export function tileToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** タイルの番号（北端）→ 緯度 */
export function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** 国土地理院「シームレス写真」（航空写真）のタイルの URL。CORS 許可（*）を確認済み */
export const photoUrl = (z: number, x: number, y: number): string =>
  `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`;

/** 緯度 1 度・経度 1 度がおよそ何メートルか（その緯度での概算） */
export function metersPerDeg(latDeg: number): { lat: number; lon: number } {
  const phi = (latDeg * Math.PI) / 180;
  return { lat: 111132.09 - 566.05 * Math.cos(2 * phi), lon: 111412.84 * Math.cos(phi) };
}

/**
 * 中心（緯度・経度）の周り、四方 cover メートル以上を覆うタイルの範囲（両端を含む）。
 * x が西→東、y が北→南。
 */
export function planTileRange(lat: number, lon: number, zoom: number, cover: number): { x0: number; x1: number; y0: number; y1: number } {
  const m = metersPerDeg(lat);
  const latN = lat + cover / m.lat;
  const latS = lat - cover / m.lat;
  const lonW = lon - cover / m.lon;
  const lonE = lon + cover / m.lon;
  return {
    x0: lonToTileX(lonW, zoom),
    x1: lonToTileX(lonE, zoom),
    y0: latToTileY(latN, zoom),
    y1: latToTileY(latS, zoom),
  };
}
