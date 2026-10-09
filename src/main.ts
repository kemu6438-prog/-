// 建物データ確認ページ（M0）。
// 本物の建物データ（PLATEAU）を、名古屋（名駅・栄）や東京駅の上空に表示して、
// 読み込み量とコマ数を測る。まだ「街」ではなく、箱形の建物と平らな地面だけ。
/** この配布物の番号（反映されたかの確認用。パネルのログと、ページのタイトルに出る） */
const BUILD_ID = "20";
import { StallMeter } from "./core/stalls";
import * as THREE from "three/webgpu";
import { setupLook } from "./render/look";
import { LocalFrame } from "./core/geo";
import { Buildings } from "./world/buildings";
import { Roads } from "./world/roads";
import { Driver } from "./world/drive";
import { SEATS, createInterior, type SeatId } from "./world/carInterior";
import { loadTextures } from "./render/assets";
import { findBuildingTilesets } from "./world/plateau";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const isMobile = matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

const logLines: string[] = [];
function log(m: string) {
  const t = new Date().toLocaleTimeString("ja-JP");
  logLines.push(`${t} ${m}`);
  if (logLines.length > 40) logLines.shift();
  $("log").textContent = logLines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;
  console.log(m);
}

type Place = { id: string; label: string; lat: number; lon: number; codes: string[]; groundH: number };
// 地面の高さ(楕円体高) = 標高 + ジオイド高(日本中部で約 37〜38 m)。仮の値。ボタンで調整できる。
const PLACES: Place[] = [
  { id: "nagoya", label: "名古屋駅", lat: 35.17095, lon: 136.8816, codes: ["231"], groundH: 41 },
  { id: "sakae", label: "栄", lat: 35.1705, lon: 136.9084, codes: ["231"], groundH: 41 },
  { id: "tokyo", label: "（予備）東京駅", lat: 35.6812, lon: 139.7671, codes: ["13101", "13102"], groundH: 40 },
];

async function gpuName(): Promise<string> {
  try {
    const gpu = (navigator as any).gpu;
    const info = (await gpu?.requestAdapter())?.info;
    const s = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ");
    if (s) return s;
  } catch { /* 取れなくても続ける */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch { /* 同上 */ }
  return "不明";
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).get("gl") === "1" });
  // 解像度（画面の細かさ）。重いときは自動で下げ、余裕があれば戻す
  const baseRatio = Math.min(window.devicePixelRatio, isMobile ? 1.25 : 1.5);
  let curRatio = baseRatio;
  let ratioMode: "auto" | number = "auto";
  { const r = Number(new URLSearchParams(location.search).get("ratio")); if (r > 0) { ratioMode = r; curRatio = baseRatio * r; } }
  renderer.setPixelRatio(curRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.prepend(renderer.domElement);
  await renderer.init();
  const isWebGPU = (renderer.backend as any).isWebGPUBackend === true;
  $("backend").textContent = isWebGPU ? "WebGPU" : "WebGL 2（互換）";
  gpuName().then((n) => ($("gpu").textContent = n));
  // 止まった・落ちたときの原因をログに残す（GPU が止まった理由、GPU の命令の間違い、その他のエラー）
  {
    const dev = (renderer.backend as any).device as any;
    dev?.lost?.then((i: { reason: string; message: string }) => log(`【GPU が停止】${i.reason}: ${i.message}`));
    let gpuErrs = 0;
    dev?.addEventListener?.("uncapturederror", (e: { error: { message: string } }) => { if (++gpuErrs <= 5) log(`【GPU エラー】${e.error.message.slice(0, 200)}`); });
    let jsErrs = 0;
    window.addEventListener("error", (e) => { if (++jsErrs <= 5) log(`【エラー】${e.message}`); });
    window.addEventListener("unhandledrejection", (e) => { if (++jsErrs <= 5) log(`【エラー】${String((e.reason as Error)?.message ?? e.reason).slice(0, 200)}`); });
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.8, 9000);
  const look = setupLook(renderer, scene, camera, { isMobile, log });
  loadTextures(log); // ネットの無料素材（CC0）を読み込む。読めなければ自作の模様のまま

  // 状態
  let place = PLACES[0];
  let frame = new LocalFrame({ lat: place.lat, lon: place.lon, h: place.groundH });
  let groundH = place.groundH;
  // 地面は 8m 角ほどに区切った板にする（巨大な 1 枚の板だと奥行きの計算がずれて、道路が地面の下に隠れてしまう。以前の 2.5m 角は三角形が多すぎたので粗くした）
  // 地面は道路より 12cm 沈めておく（同じ高さだと奥行きの比べ方が画面の大きさで変わり、近くの道路が地面に隠れることがあった）
  const GROUND_Y = -0.12;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 50, 50), look.groundMaterial);
  ground.receiveShadow = true;
  ground.position.y = GROUND_Y;
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // 遠くは粗い輪っか状の板で埋める（真ん中は空けておく。近くに巨大な板があると、奥行きの計算がずれて道路が隠れる）（霞で見えにくい所。少し低くして重ならないようにする）
  // 中くらいの距離（半径 190m〜2100m）の地面。さらに少し低くして、近くの地面と重なっても負けるようにする
  const midGround = new THREE.Mesh(new THREE.RingGeometry(190, 2100, 128, 8), look.groundMaterial);
  midGround.rotation.x = -Math.PI / 2;
  midGround.position.y = GROUND_Y - 0.2;
  scene.add(midGround);
  const farGround = new THREE.Mesh(new THREE.RingGeometry(2000, 12000, 96, 1), look.groundMaterial);
  farGround.rotation.x = -Math.PI / 2;
  farGround.position.y = -0.6;
  scene.add(farGround);
  // 地面は建物・木より後（道路より前）に描く。先に建物を描いておくと、建物の裏に隠れる地面の画素は、重い塗りをせずに済む
  for (const g of [ground, midGround, farGround]) g.renderOrder = 50;
  if (new URLSearchParams(location.search).get("ground") === "0") { ground.visible = false; midGround.visible = false; farGround.visible = false; }

  const buildings = new Buildings(camera, renderer, frame, log, isMobile ? 26 : 16);
  buildings.radius = isMobile ? 1500 : 2000;
  scene.add(buildings.group);

  // 道路・歩道・街路樹など（?roads=0 で出さない）
  const roads = new Roads(log);
  roads.radius = isMobile ? 800 : 1100; // 道の面は 1 km より遠いと、ほとんど建物の陰で見えない。重さの割に見返りが少ない
  roads.treeRadius = isMobile ? 450 : 700;
  scene.add(roads.group);
  const roadsOn = new URLSearchParams(location.search).get("roads") !== "0";
  // 建物と重なる木・小物を消す（?fp=0 で無効）
  const footprintCull = new URLSearchParams(location.search).get("fp") !== "0";
  let lastCulled = 0, lastCullLog = 0;
  log(`版: ${BUILD_ID}`);
  document.title = `${document.title} (${BUILD_ID})`;

  let placeToken = 0;
  async function loadPlace(p: Place) {
    const myToken = ++placeToken; // ボタンを続けて押したとき、前の場所の建物が後から混ざらないようにする
    place = p;
    groundH = p.groundH;
    frame = new LocalFrame({ lat: p.lat, lon: p.lon, h: groundH });
    ground.position.y = GROUND_Y;
    $("gh").textContent = `${groundH}`;
    buildings.clear();
    buildings.setFrame(frame);
    roads.clear();
    // 場所を変えたら、運転のための道データも古くなるので作り直す
    driver = null;
    if (mode === "drive") setMode("auto");
    roads.begin(frame, groundH); // 道・木は、カメラの近くのタイルを毎コマ少しずつ作る（update）
    camera.position.set(0, 160, 420);
    yaw = 0; pitch = -0.25; orbitT = 0;
    log(`場所: ${p.label} / 建物: LOD${buildings.lod}`);
    const sets = await findBuildingTilesets(p.codes, buildings.lod, log);
    if (myToken !== placeToken) return;
    for (const s of sets) {
      log(`建物データ: ${s.label}\n  ${s.url}`);
      buildings.add(s.url, s.label);
    }
  }

  // --- ボタン ---
  PLACES.forEach((p) => {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.onclick = () => {
      $("places").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      void loadPlace(p);
    };
    $("places").appendChild(b);
  });
  [1000, 2000, 3000].forEach((r) => {
    const b = document.createElement("button");
    b.textContent = `${r / 1000} km`;
    if (r === buildings.radius) b.classList.add("on");
    b.onclick = () => {
      buildings.radius = r;
      $("radius").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      log(`読み込む範囲: ${r} m`);
    };
    $("radius").appendChild(b);
  });
  // 画質（低: 影なし / 中: 影＋空の映り込み）
  (["low", "mid"] as const).forEach((q) => {
    const b = document.createElement("button");
    b.textContent = { low: "低", mid: "中" }[q];
    if (q === look.quality) b.classList.add("on");
    b.onclick = () => {
      look.setQuality(q);
      $("quality").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      log(`画質: ${b.textContent}`);
    };
    $("quality").appendChild(b);
  });
  // 影のあり/なし（影は重いので、遅いときは自動で切る）
  let shadowOn = true;
  const shadowBtns: Record<string, HTMLButtonElement> = {};
  const setShadow = (on: boolean, why = "") => {
    shadowOn = on;
    look.setOptions({ shadow: on });
    shadowBtns.on.classList.toggle("on", on);
    shadowBtns.off.classList.toggle("on", !on);
    log(`影: ${on ? "あり" : "なし"}${why}`);
  };
  ([["on", "あり"], ["off", "なし"]] as const).forEach(([k, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => setShadow(k === "on");
    shadowBtns[k] = b;
    $("shadowrow").appendChild(b);
  });
  shadowBtns.on.classList.add("on");
  const setRatio = (r: number) => {
    curRatio = r;
    renderer.setPixelRatio(r);
    renderer.setSize(window.innerWidth, window.innerHeight);
    $("res").textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;
  };
  ([["auto", "自動"], [1, "100%"], [0.75, "75%"], [0.5, "50%"]] as const).forEach(([v, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (v === "auto") b.classList.add("on");
    b.onclick = () => {
      ratioMode = v;
      $("scale").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      setRatio(v === "auto" ? baseRatio : baseRatio * v);
      log(`解像度: ${label}`);
    };
    $("scale").appendChild(b);
  });

  $("full").onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => log("全画面にできませんでした。埋め込み表示では使えません。「別タブで開く」を押してください"));
  };

  $("newtab").onclick = () => {
    window.open(location.href, "_blank", "noopener");
    log("別タブで開きました。そちらで「全画面にする」を押してください");
  };

  // --- 性能の内訳を測る（止まっているときと、動いているときの両方で、機能を 1 つずつ切って比べる） ---
  let renderRepeat = 1;
  let benchSamples: number[] | null = null;
  let benching = false;
  let benchMoving = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function runBench() {
    if (benching) return;
    benching = true;
    const keepMode = ratioMode;
    const setAll = (o: { shadow: boolean }, b: boolean, r: boolean, ratio: number, frozen = false, hideInst = false) => {
      look.setOptions(o);
      look.freezeShadow(frozen);
      roads.hideInstanced = hideInst;
      buildings.group.visible = b;
      roads.group.visible = r;
      if (ratio !== curRatio) setRatio(ratio);
    };
    const ALL = { shadow: shadowOn };
    // [名前, 動かすか, 設定]
    const steps: [string, boolean, () => void][] = [
      ["止まっている・いまの設定", false, () => setAll(ALL, true, true, baseRatio)],
      ["動く・いまの設定", true, () => setAll(ALL, true, true, baseRatio)],
      ["動く・影の描き直しを止める", true, () => setAll(ALL, true, true, baseRatio, true)],
      ["動く・影を切る", true, () => setAll({ ...ALL, shadow: false }, true, true, baseRatio)],
      ["動く・建物を隠す", true, () => setAll(ALL, false, true, baseRatio)],
      ["動く・道路・木などを全部隠す", true, () => setAll(ALL, true, false, baseRatio)],
      ["動く・木・街灯などだけ隠す（道路の面は残す）", true, () => setAll(ALL, true, true, baseRatio, false, true)],
      ["動く・解像度を半分にする", true, () => setAll(ALL, true, true, baseRatio * 0.5)],
    ];
    log("【性能の内訳を測定中】約 1 分。自動で少し前後に動きます。触らずに待ってください");
    const res: { name: string; ms: number }[] = [];
    for (const [name, moving, apply] of steps) {
      apply();
      benchMoving = moving;
      await sleep(4500); // 新しい設定の準備（シェーダーの作り直し）を待つ
      benchSamples = [];
      await sleep(3500);
      const a = benchSamples;
      benchSamples = null;
      const sorted = [...a].sort((x, y) => x - y);
      const ms = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; // 中央値（コマが 1 つも来なかったら NaN）
      const avg = a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
      res.push({ name, ms });
      log(`  ${name}: 中央 ${ms.toFixed(0)} ms / 平均 ${avg.toFixed(0)} ms（約 ${(1000 / avg).toFixed(0)} コマ/秒）`);
    }
    benchMoving = false;
    setAll(ALL, true, true, baseRatio);
    roads.hideInstanced = false;
    ratioMode = keepMode;
    setRatio(keepMode === "auto" ? baseRatio : baseRatio * keepMode);
    log("【測定おわり】上の行をそのまま貼ってください");
    benching = false;
  }
  $("bench").onclick = () => void runBench();

  // 詳細モデル(LOD2)は壊れて表示され、メモリも重いので、普段は隠す（?lod2=1 を付けた時だけ出す）
  const showLod2 = new URLSearchParams(location.search).has("lod2");
  if (!showLod2) $("lod").parentElement!.style.display = "none";
  ([1, 2] as const).forEach((lod) => {
    const b = document.createElement("button");
    b.textContent = lod === 1 ? "箱＋窓（軽い）" : "詳細モデル LOD2（重い・試験）";
    if (lod === buildings.lod) b.classList.add("on");
    b.onclick = () => {
      buildings.lod = lod;
      $("lod").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      void loadPlace(place);
    };
    $("lod").appendChild(b);
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-g]").forEach((b) => {
    b.onclick = () => {
      const d = Number(b.dataset.g);
      groundH += d;
      // 地面の平面を動かす代わりに、原点の高さを動かして建物との相対位置を変える
      frame = new LocalFrame({ lat: place.lat, lon: place.lon, h: groundH });
      buildings.setFrame(frame);
      $("gh").textContent = `${groundH}`;
      log(`地面の高さ: ${groundH} m`);
    };
  });
  $("places").querySelector("button")!.classList.add("on");

  // --- カメラ ---
  let mode: "auto" | "free" | "drive" = "auto";
  let driver: Driver | null = null;
  // 画面の文字は、変わったときだけ書き換える（毎コマ書くと無駄に再計算される）
  const hudLast: Record<string, string> = {};
  const setHud = (id: string, v: string) => { if (hudLast[id] !== v) { hudLast[id] = v; $(id).textContent = v; } };
  const interior = createInterior(); // 車の中（拡大して置き、奥→手前の順で重ねる）
  scene.add(interior.car);
  let seat: SeatId = "driver";
  let lookYaw = 0, lookPitch = 0;
  let yaw = 0, pitch = -0.25, orbitT = 0;
  let streetEye = false;
  // 確認用: ?orbit=距離&h=高さ で自動周回の位置を変えられる
  const qs = new URLSearchParams(location.search);
  const orbitR = Number(qs.get("orbit")) || 450;
  const orbitH = Number(qs.get("h")) || 150;
  const setMode = (m: "auto" | "free" | "drive") => {
    mode = m;
    if (m === "auto") streetEye = false;
    $("auto").classList.toggle("on", m === "auto");
    $("free").classList.toggle("on", m === "free");
    $("drive").classList.toggle("on", m === "drive");
    $("hud").style.display = m === "drive" ? "block" : "none";
    $("hudctl").style.display = m === "drive" ? "block" : "none";
    interior.car.visible = m === "drive";

    $("fwd").style.display = m === "free" && isMobile ? "block" : "none";
  };
  // 車に乗る（自動運転）。道路データがそろっていれば、いまの場所に近い道から出発する
  $("drive").onclick = () => {
    if (roads.lines.length === 0) { log("道路データがまだ読み込めていません。少し待ってからもう一度押してください"); return; }
    if (!driver) driver = new Driver(roads.lines, roads.nodes);
    const from = camera.position;
    const cx = mode === "drive" ? 0 : Math.abs(from.x) < 2000 && Math.abs(from.z) < 2000 ? from.x : 0;
    const cz = mode === "drive" ? 0 : Math.abs(from.x) < 2000 && Math.abs(from.z) < 2000 ? from.z : 0;
    if (!driver.start(cx, cz)) { log("走れる道が見つかりませんでした"); return; }
    lookYaw = 0; lookPitch = 0;
    streetEye = false;
    setMode("drive");
    log("車に乗りました（自動運転・左側通行）。画面をドラッグすると見回せます");
  };
  $("auto").onclick = () => setMode("auto");
  $("free").onclick = () => setMode("free");
  // 車に乗った高さの見え方を確かめる（ゆっくり歩く速さで動ける）
  $("street").onclick = () => {
    setMode("free");
    camera.position.y = 1.6;
    pitch = 0;
    streetEye = true;
  };
  // 座席の選択と、見回しを正面に戻す
  (Object.keys(SEATS) as SeatId[]).forEach((id) => {
    const b = document.createElement("button");
    b.textContent = SEATS[id].label;
    b.dataset.seat = id;
    b.onclick = () => {
      seat = id;
      lookYaw = 0; lookPitch = 0;
      for (const o of $("seatrow").querySelectorAll("button")) o.classList.toggle("on", (o as HTMLElement).dataset.seat === id);
    };
    if (id === seat) b.classList.add("on");
    $("seatrow").appendChild(b);
  });
  $("lookreset").onclick = () => { lookYaw = 0; lookPitch = 0; };
  setMode("auto");
  $("hide").onclick = () => {
    const p = $("panel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };

  const keys = new Set<string>();
  addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  let dragging = false, lx = 0, ly = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true; lx = e.clientX; ly = e.clientY;
    if (mode === "auto") setMode("free");
  });
  addEventListener("pointerup", () => (dragging = false));
  addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (mode === "drive") {
      lookYaw -= (e.clientX - lx) * 0.004;
      lookPitch = Math.max(-1.45, Math.min(1.45, lookPitch - (e.clientY - ly) * 0.004));
    } else {
      yaw -= (e.clientX - lx) * 0.004;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - (e.clientY - ly) * 0.004));
    }
    lx = e.clientX; ly = e.clientY;
  });
  let fwd = false;
  $("fwd").addEventListener("pointerdown", (e) => { e.stopPropagation(); fwd = true; });
  addEventListener("pointerup", () => (fwd = false));

  addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    buildings.onResize();
    $("res").textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;
  });
  $("res").textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;

  (window as unknown as { __dbg: unknown }).__dbg = { roads, camera, scene, THREE };
  void loadPlace(place);
  // 確認用: ?cam=x,y,z,向き(度),上下(度) で、自分で動かすモードの開始位置を決められる
  if (qs.has("cam")) {
    const [cx, cy, cz, cyaw = 0, cpitch = 0] = qs.get("cam")!.split(",").map(Number);
    camera.position.set(cx, cy, cz);
    yaw = (cyaw * Math.PI) / 180;
    pitch = (cpitch * Math.PI) / 180;
    setMode("free");
    streetEye = cy < 3;
  }


  // --- 毎コマの処理 ---
  let frames = 0, acc = 0, worst = 0, last = performance.now(), lastStats = 0;
  let hitchLogged = 0, lastRedraws = 0, hitchRen = 0, hitchUpd = 0, hitchRoad = 0, hitchTile = 0, hitchShadow = false;
  let jsUpd = 0, jsRen = 0, lowSec = 0, okSec = 0, worstUpd = 0, worstRen = 0;
  const tmp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  // 引っかかりの犯人探し（見るだけ）。走っている間、10 秒ごとに「時間がどこで失われたか」を記録する
  const stalls = new StallMeter(log);
  let lastLoaded = 0, lastRoadTiles = 0, lastSumMode = "";
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    const gap = now - last; // 前のコマから何 ms 空いたか
    benchSamples?.push(now - last);
    frames++; acc += now - last; worst = Math.max(worst, now - last); last = now;
    if (acc >= 1000) {
      const fpsNow = (frames * 1000) / acc;
      $("fps").textContent = String(Math.round(fpsNow));
      $("ms").textContent = `（最長 ${worst.toFixed(0)} ms / 処理: 更新 ${(jsUpd / frames).toFixed(1)}（最長 ${worstUpd.toFixed(0)}） + 描画命令 ${(jsRen / frames).toFixed(1)}（最長 ${worstRen.toFixed(0)}） ms）`;
      // 影は自動では切らない（重いときはパネルの「影」で自分で切る）
      // 自動の解像度調整: 重ければ下げ、軽ければ少しずつ戻す
      if (ratioMode === "auto" && !benching) {
        if (fpsNow < 52) { lowSec++; okSec = 0; } else if (fpsNow > 58.5) { okSec++; lowSec = 0; } else { lowSec = 0; okSec = 0; }
        if (lowSec >= 2 && curRatio > baseRatio * 0.5) { setRatio(Math.max(baseRatio * 0.5, curRatio * 0.88)); lowSec = 0; }
        else if (okSec >= 6 && curRatio < baseRatio) { setRatio(Math.min(baseRatio, curRatio * 1.1)); okSec = 0; }
      }
      frames = 0; acc = 0; worst = 0; jsUpd = 0; jsRen = 0; worstUpd = 0; worstRen = 0;
    }

    if (mode === "auto") {
      orbitT += dt;
      const a = orbitT * 0.08;
      camera.position.set(Math.sin(a) * orbitR, orbitH, Math.cos(a) * orbitR);
      camera.lookAt(0, Math.min(30, orbitH), 0);
    } else if (mode === "drive" && driver) {
      driver.update(dt);
      // 見回しは自由（ドラッグ・矢印キー）。勝手に正面へは戻さない（「正面に戻す」ボタン・R キーで戻る）
      const lk = 1.8 * dt;
      if (keys.has("arrowleft")) lookYaw += lk;
      if (keys.has("arrowright")) lookYaw -= lk;
      if (keys.has("arrowup")) lookPitch = Math.min(1.45, lookPitch + lk);
      if (keys.has("arrowdown")) lookPitch = Math.max(-1.45, lookPitch - lk);
      if (keys.has("r")) { lookYaw = 0; lookPitch = 0; }
      if (lookYaw > Math.PI) lookYaw -= 2 * Math.PI;
      if (lookYaw < -Math.PI) lookYaw += 2 * Math.PI;
      // 車の位置と向き。目は座席の位置（車の向きに合わせて回る）
      const sy = Math.sin(driver.yaw), cy = Math.cos(driver.yaw);
      const st = SEATS[seat];
      // 車の座標 (x: 右, z: 後ろ) → 世界。前 = (-sin, -cos)、右 = (cos, -sin)
      const ex = driver.pose.x + cy * st.x + sy * st.z;
      const ez = driver.pose.z - sy * st.x + cy * st.z;
      camera.position.set(ex, st.y, ez);
      camera.rotation.set(-0.02 + lookPitch, driver.yaw + lookYaw, 0, "YXZ");
      interior.place(driver.pose.x, driver.pose.z, driver.yaw, st, camera.position);
      yaw = driver.yaw;
      pitch = -0.02;
      setHud("hudspeed", String(Math.round(driver.speedKmh)));
      setHud("hudlimit", String(Math.round(driver.limitKmh)));
      setHud("hudwait", driver.speed < 0.5 ? "" : "走行中");
    } else {
      camera.rotation.set(pitch, yaw, 0, "YXZ");
      const speed = (streetEye ? (keys.has("shift") ? 40 : 10) : keys.has("shift") ? 300 : 80) * dt;
      const move = (x: number, y: number, z: number) => {
        tmp.set(x, 0, z).applyAxisAngle(UP, yaw);
        camera.position.addScaledVector(tmp, speed);
        camera.position.y += y * speed;
      };
      if (keys.has("w") || keys.has("arrowup") || fwd) move(0, 0, -1);
      if (keys.has("s") || keys.has("arrowdown")) move(0, 0, 1);
      if (keys.has("a") || keys.has("arrowleft")) move(-1, 0, 0);
      if (keys.has("d") || keys.has("arrowright")) move(1, 0, 0);
      if (keys.has("e") || keys.has("q")) streetEye = false;
      if (keys.has("e")) move(0, 1, 0);
      if (keys.has("q")) move(0, -1, 0);
      if (camera.position.y < (streetEye ? 1.6 : 2)) camera.position.y = streetEye ? 1.6 : 2;
      if (streetEye) camera.position.y = 1.6;
    }
    if (benchMoving && mode === "free") {
      // 測定中は、向いている方向へ 30m/秒で 2 秒進み、2 秒戻る
      const dir = Math.floor(now / 2000) % 2 === 0 ? 1 : -1;
      tmp.set(0, 0, -1).applyAxisAngle(UP, yaw);
      camera.position.addScaledVector(tmp, 30 * dt * dir);
    }
    // 地面は常にカメラの真下に敷く（平らな仮の地面）
    ground.position.x = camera.position.x;
    ground.position.z = camera.position.z;
    midGround.position.x = camera.position.x;
    midGround.position.z = camera.position.z;
    farGround.position.x = camera.position.x;
    farGround.position.z = camera.position.z;

    const tr0 = performance.now();
    if (roadsOn) {
      roads.update(camera.position, now);
      const nl = roads.takeNewLines();
      if (driver && nl.length) driver.addLines(nl); // 走っている先の道を足す
    }
    roads.updateLod(camera.position);
    if (footprintCull) {
      roads.cullByFootprints(buildings.footprints, camera.position);
      if (roads.culled + roads.moved !== lastCulled && now - lastCullLog > 5000) { lastCulled = roads.culled + roads.moved; lastCullLog = now; log(`建物と重なる木・小物: 消した ${roads.culled} 個 / ずらして置き直した ${roads.moved} 個`); }
    }
    const tr1 = performance.now();
    const t1 = performance.now();
    buildings.update();
    const t2 = performance.now();
    look.update();
    for (let i = 0; i < renderRepeat; i++) look.render();
    const t3 = performance.now();
    jsUpd += t2 - t1;
    jsRen += t3 - t2;
    worstUpd = Math.max(worstUpd, t2 - t1);
    worstRen = Math.max(worstRen, t3 - t2);
    // 大きな引っかかり（前のコマから 70 ms 以上）の内訳を記録する。原因（道・建物タイル・影・描画）の見当をつけるため
    const redraws = look.shadowRedraws();
    const tileMs = buildings.takeLoadMs();
    if (gap > 70 && hitchLogged < 40 && now > 8000 && !document.hidden) {
      hitchLogged++;
      log(`引っかかり ${gap.toFixed(0)} ms（前のコマの内訳: 描画命令 ${hitchRen.toFixed(0)} / 更新 ${hitchUpd.toFixed(0)} / 道 ${hitchRoad.toFixed(0)} / 建物タイル処理 ${hitchTile.toFixed(0)} / 影の描き直し ${hitchShadow ? "あり" : "なし"}）`);
    }
    hitchRen = t3 - t2; hitchUpd = t2 - t1; hitchRoad = tr1 - tr0; hitchTile = tileMs; hitchShadow = redraws !== lastRedraws; lastRedraws = redraws;

    stalls.frame(now, t3, gap);
    if (mode !== lastSumMode) { lastSumMode = mode; stalls.reset(); }
    if (mode === "drive") {
      const sm = stalls.summary("");
      if (sm) {
        const bs = buildings.stats();
        const dl = bs.loadedTiles - lastLoaded, dr = roads.stats.tiles - lastRoadTiles;
        lastLoaded = bs.loadedTiles; lastRoadTiles = roads.stats.tiles;
        log(`${sm} ｜ 建物タイル 読み込み済 ${bs.loadedTiles}（変化 ${dl >= 0 ? "+" : ""}${dl}）/ 処理中 ${bs.parsing} / 待ち ${bs.queued} ｜ 道タイル ${roads.stats.tiles}（変化 ${dr >= 0 ? "+" : ""}${dr}）`);
      }
    }

    if (now - lastStats > 500) {
      lastStats = now;
      const s = buildings.stats();
      $("tiles").textContent =
        `三角形 ${(s.triangles / 1e6).toFixed(2)} 百万 / 表示中 ${s.visible} / 読み込み済 ${s.loadedTiles} / 通信中 ${s.downloading} / 処理中 ${s.parsing} / 待ち ${s.queued} / 失敗 ${s.failed} / 使用メモリ ${s.cacheMB.toFixed(0)} MB`;
    }
  });
}

main().catch((e) => {
  $("backend").textContent = "エラー: " + (e?.message ?? e);
  log("致命的エラー: " + (e?.stack ?? e));
});
