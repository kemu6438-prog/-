// 建物データ確認ページ（M0）。
// 本物の建物データ（PLATEAU）を、名古屋（名駅・栄）や東京駅の上空に表示して、
// 読み込み量とコマ数を測る。まだ「街」ではなく、箱形の建物と平らな地面だけ。
import * as THREE from "three/webgpu";
import { setupLook } from "./render/look";
import { LocalFrame } from "./core/geo";
import { Buildings } from "./world/buildings";
import { Roads } from "./world/roads";
import { signalClock } from "./world/signal";
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
  const renderer = new THREE.WebGPURenderer({ antialias: false });
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

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.8, 9000);
  const look = setupLook(renderer, scene, camera, { isMobile, log });
  loadTextures(log); // ネットの無料素材（CC0）を読み込む。読めなければ自作の模様のまま

  // 状態
  let place = PLACES[0];
  let frame = new LocalFrame({ lat: place.lat, lon: place.lon, h: place.groundH });
  let groundH = place.groundH;
  // 地面は細かく区切った板にする（巨大な 1 枚の板だと奥行きの計算がずれて、道路が地面の下に隠れてしまう）
  // 地面は道路より 12cm 沈めておく（同じ高さだと奥行きの比べ方が画面の大きさで変わり、近くの道路が地面に隠れることがあった）
  const GROUND_Y = -0.12;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 160, 160), look.groundMaterial);
  ground.receiveShadow = true;
  ground.position.y = GROUND_Y;
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // 遠くは粗い輪っか状の板で埋める（真ん中は空けておく。近くに巨大な板があると、奥行きの計算がずれて道路が隠れる）（霞で見えにくい所。少し低くして重ならないようにする）
  // 中くらいの距離（半径 190m〜2100m）の地面。さらに少し低くして、近くの地面と重なっても負けるようにする
  const midGround = new THREE.Mesh(new THREE.RingGeometry(190, 2100, 128, 24), look.groundMaterial);
  midGround.rotation.x = -Math.PI / 2;
  midGround.position.y = GROUND_Y - 0.2;
  scene.add(midGround);
  const farGround = new THREE.Mesh(new THREE.RingGeometry(2000, 12000, 96, 1), look.groundMaterial);
  farGround.rotation.x = -Math.PI / 2;
  farGround.position.y = -0.6;
  scene.add(farGround);
  if (new URLSearchParams(location.search).get("ground") === "0") { ground.visible = false; midGround.visible = false; farGround.visible = false; }

  const buildings = new Buildings(camera, renderer, frame, log, isMobile ? 26 : 16);
  buildings.radius = isMobile ? 1500 : 2000;
  scene.add(buildings.group);

  // 道路・歩道・街路樹・信号（?roads=0 で出さない）
  const roads = new Roads(log);
  roads.radius = isMobile ? 1200 : 1500;
  roads.treeRadius = isMobile ? 450 : 700;
  scene.add(roads.group);
  const roadsOn = new URLSearchParams(location.search).get("roads") !== "0";

  async function loadPlace(p: Place) {
    place = p;
    groundH = p.groundH;
    frame = new LocalFrame({ lat: p.lat, lon: p.lon, h: groundH });
    ground.position.y = GROUND_Y;
    $("gh").textContent = `${groundH}`;
    buildings.clear();
    buildings.setFrame(frame);
    roads.clear();
    if (roadsOn) void roads.load(frame, p.lat, p.lon, groundH).catch((e) => log(`道路の作成に失敗: ${e?.stack ?? e}`));
    camera.position.set(0, 160, 420);
    yaw = 0; pitch = -0.25; orbitT = 0;
    log(`場所: ${p.label} / 建物: LOD${buildings.lod}`);
    const sets = await findBuildingTilesets(p.codes, buildings.lod, log);
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
  // 画質（低: 影なし / 中: 影＋空の映り込み / 高: さらに暗がり・光のにじみ・縁のなめらか化）
  (["low", "mid", "high"] as const).forEach((q) => {
    const b = document.createElement("button");
    b.textContent = { low: "低", mid: "中", high: "高" }[q];
    if (q === look.quality) b.classList.add("on");
    b.onclick = () => {
      look.setQuality(q);
      $("quality").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      log(`画質: ${b.textContent}`);
    };
    $("quality").appendChild(b);
  });
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

  // --- 性能の内訳を測る（いまの見え方のまま、機能を 1 つずつ切って 1 コマの時間を比べる） ---
  let renderRepeat = 1;
  let benchSamples: number[] | null = null;
  let benching = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function runBench() {
    if (benching) return;
    benching = true;
    const keepMode = ratioMode;
    const setAll = (o: { shadow: boolean; ao: boolean; post: boolean }, b: boolean, r: boolean, ratio: number) => {
      look.setOptions(o);
      buildings.group.visible = b;
      roads.group.visible = r;
      if (ratio !== curRatio) setRatio(ratio);
    };
    const ALL = { shadow: true, ao: true, post: true };
    const steps: [string, () => void][] = [
      ["いまの設定", () => setAll(ALL, true, true, baseRatio)],
      ["影を切る", () => setAll({ ...ALL, shadow: false }, true, true, baseRatio)],
      ["影＋暗がりを切る", () => setAll({ shadow: false, ao: false, post: true }, true, true, baseRatio)],
      ["影＋暗がり＋にじみ・縁なめらかを切る", () => setAll({ shadow: false, ao: false, post: false }, true, true, baseRatio)],
      ["建物を隠す", () => setAll(ALL, false, true, baseRatio)],
      ["道路・木・信号を隠す", () => setAll(ALL, true, false, baseRatio)],
      ["解像度を半分にする", () => setAll(ALL, true, true, baseRatio * 0.5)],
    ];
    log("【性能の内訳を測定中】約 40 秒、カメラを動かさず待ってください");
    const res: { name: string; ms: number }[] = [];
    for (const [name, apply] of steps) {
      apply();
      await sleep(4500); // 新しい設定の準備（シェーダーの作り直し・読み込み）を待つ
      benchSamples = [];
      await sleep(3500);
      const a = benchSamples;
      benchSamples = null;
      const sorted = [...a].sort((x, y) => x - y);
      const ms = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; // 中央値（一瞬の引っかかりに引きずられない）
      res.push({ name, ms });
      log(`  ${name}: 1コマ ${ms.toFixed(1)} ms（${(1000 / ms).toFixed(0)} コマ/秒）`);
    }
    setAll(ALL, true, true, baseRatio);
    renderRepeat = 1;
    ratioMode = keepMode;
    setRatio(keepMode === "auto" ? baseRatio : baseRatio * keepMode);
    const base = res[0].ms;
    const gain = (i: number) => base - res[i].ms;
    const parts: [string, number][] = [
      ["影", gain(1)],
      ["暗がり(AO)", gain(2) - gain(1)],
      ["にじみ・縁なめらか", gain(3) - gain(2)],
      ["建物", gain(4)],
      ["道路・木・信号", gain(5)],
    ];
    log("【結果】1コマの時間のうち、その機能が使っている目安（ms。大きいほど重い）:");
    for (const [n, v] of parts) log(`  ${n}: 約 ${v.toFixed(1)} ms`);
    log(`  解像度を半分にすると ${base.toFixed(1)} → ${res[6].ms.toFixed(1)} ms（${res[6].ms < base * 0.65 ? "描画の細かさ（ピクセル数）が主な重さ" : "ピクセル数以外（形の数など）も重い"}）`);
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
  let mode: "auto" | "free" = "auto";
  let yaw = 0, pitch = -0.25, orbitT = 0;
  let streetEye = false;
  // 確認用: ?orbit=距離&h=高さ で自動周回の位置を変えられる
  const qs = new URLSearchParams(location.search);
  const orbitR = Number(qs.get("orbit")) || 450;
  const orbitH = Number(qs.get("h")) || 150;
  const setMode = (m: "auto" | "free") => {
    mode = m;
    if (m === "auto") streetEye = false;
    $("auto").classList.toggle("on", m === "auto");
    $("free").classList.toggle("on", m === "free");
    $("fwd").style.display = m === "free" && isMobile ? "block" : "none";
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
    yaw -= (e.clientX - lx) * 0.004;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - (e.clientY - ly) * 0.004));
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
  let jsUpd = 0, jsRen = 0, lowSec = 0, okSec = 0, worstUpd = 0, worstRen = 0;
  const tmp = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    benchSamples?.push(now - last);
    frames++; acc += now - last; worst = Math.max(worst, now - last); last = now;
    if (acc >= 1000) {
      const fpsNow = (frames * 1000) / acc;
      $("fps").textContent = String(Math.round(fpsNow));
      $("ms").textContent = `（最長 ${worst.toFixed(0)} ms / 処理: 更新 ${(jsUpd / frames).toFixed(1)}（最長 ${worstUpd.toFixed(0)}） + 描画命令 ${(jsRen / frames).toFixed(1)}（最長 ${worstRen.toFixed(0)}） ms）`;
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
    } else {
      camera.rotation.set(pitch, yaw, 0, "YXZ");
      const speed = (streetEye ? (keys.has("shift") ? 40 : 10) : keys.has("shift") ? 300 : 80) * dt;
      const move = (x: number, y: number, z: number) => {
        tmp.set(x, 0, z).applyEuler(new THREE.Euler(0, yaw, 0));
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
    // 地面は常にカメラの真下に敷く（平らな仮の地面）
    ground.position.x = camera.position.x;
    ground.position.z = camera.position.z;
    midGround.position.x = camera.position.x;
    midGround.position.z = camera.position.z;
    farGround.position.x = camera.position.x;
    farGround.position.z = camera.position.z;

    signalClock.value = now / 1000;
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
