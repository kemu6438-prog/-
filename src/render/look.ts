// 画面全体の「絵作り」: 空・太陽の光と影・空の映り込み・暗がり・光のにじみ・遠くのかすみ。
// 画質は 低 / 中 から選べる（重いときは下げる）。
import { TEX } from "./assets";
import * as THREE from "three/webgpu";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { float, length, mix, positionView, positionWorld, smoothstep, vec2, vec3 } from "three/tsl";
import { vnoise, type N } from "./noise";
import { makeClouds } from "./clouds";

export type Quality = "low" | "mid";

export type Look = {
  group: THREE.Group;
  quality: Quality;
  setQuality(q: Quality): void;
  /** 毎コマ、カメラの位置に合わせて空と影を動かす */
  update(): void;
  render(): void;
  /** 性能の切り分け用: 影を切る */
  setOptions(o: Partial<{ shadow: boolean }>): void;
  /** true の間は影の絵を描き直さない（測定用） */
  freezeShadow(b: boolean): void;
  /** 影の絵を描き直した回数（確認用） */
  shadowRedraws(): number;
  groundMaterial: THREE.MeshStandardNodeMaterial;
  /** 太陽の向き（単位ベクトル。街の外の場面の光をそろえる用） */
  sunDir: THREE.Vector3;
};

const SKY_RADIUS = 7000;

export function setupLook(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  opts: { isMobile: boolean; log: (m: string) => void },
): Look {
  const { isMobile, log } = opts;
  const group = new THREE.Group();
  scene.add(group);
  // 確認用: ?exp=露出&env=空の映り込み&sun=太陽の強さ&fog=かすみ&bloom=にじみ で見た目の調整ができる
  const qs = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);

  // --- 太陽の向き（朝〜昼のあいだ。時刻の機能は後で作る） ---
  const sunDir = new THREE.Vector3();
  const setSun = (elevationDeg: number, azimuthDeg: number) => {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  };
  setSun(34, 130);

  // --- 空（大気のシミュレーション＋雲） ---
  const sky = new SkyMesh();
  sky.scale.setScalar(SKY_RADIUS);
  (sky.material as THREE.NodeMaterial).fog = false;
  sky.turbidity.value = 3.2;
  sky.rayleigh.value = 1.3;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.82;
  sky.cloudCoverage.value = 0; // 雲は自前（clouds.ts）。three 付属の雲は模様が粗く重いので使わない
  sky.sunPosition.value.copy(sunDir);
  group.add(sky);
  const clouds = makeClouds(sunDir, num("clouds", 0.5));
  clouds.visible = num("clouds", 0.5) > 0;
  group.add(clouds);

  // --- 空の映り込み用の環境（太陽の円盤は消して作る） ---
  const envScene = new THREE.Scene();
  const envSky = new SkyMesh();
  envSky.scale.setScalar(SKY_RADIUS);
  envSky.turbidity.value = sky.turbidity.value;
  envSky.rayleigh.value = sky.rayleigh.value;
  envSky.mieCoefficient.value = sky.mieCoefficient.value;
  envSky.mieDirectionalG.value = sky.mieDirectionalG.value;
  envSky.cloudCoverage.value = 0;
  envSky.sunPosition.value.copy(sunDir);
  envSky.showSunDisc.value = 0;
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0, 1, SKY_RADIUS * 2);
  scene.environment = envRT.texture;
  scene.environmentIntensity = num("env", 0.22);

  // --- 光 ---
  const hemi = new THREE.HemisphereLight(0xe6efff, 0x9a8f78, 0.11);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, num("sun", 2.6));
  sun.castShadow = true;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1800;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 1.2;
  group.add(sun, sun.target);

  // --- かすみ（遠くほど空の色に溶ける） ---
  scene.background = null;
  scene.fog = new THREE.FogExp2(0xbdd3ea, num("fog", 0.00024));

  // --- 色調（映画のような階調） ---
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num("exp", 0.6);
  renderer.shadowMap.enabled = true;
  // 影の縁のぼかしは、軽い方式（PCF）にする。PCFSoft は 1 画素あたりの参照回数が多く、影を受ける全部の面で重くなる
  renderer.shadowMap.type = qs.get("softshadow") === "1" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

  // --- 地面（コンクリートと砂利。道路を作るまでの仮） ---
  const groundMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  {
    const p: N = vec2(positionWorld.x, positionWorld.z);
    // 地面の芝は、いったんやめた（草を消す指示）。道路の外の地面は、明るめのコンクリートと砂利だけ。
    // 道路そのものは roads.ts の専用の面で描くので、ここは「道路以外」の色。
    const n2: N = vnoise(p.mul(0.35));
    const lot: N = mix(vec3(0.42, 0.41, 0.39), vec3(0.54, 0.52, 0.48), n2)
      .mul(float(0.92).add(n2.mul(0.16)));
    // 影の濃淡: 地面の「影の中の明るさ」に、大きなむら（広場ごと・街区ごとの違い）をつける
    groundMaterial.aoNode = mix(float(0.55), float(1.0), smoothstep(0.15, 0.85, vnoise(p.mul(0.021).add(vec2(37.0, 11.0)))));
    groundMaterial.colorNode = lot.mul(TEX.concrete.detail(p)).mul(n2.mul(0.14).add(0.93));
  }

  // --- 画質ごとの組み立て（低: 影なし / 中: 影＋空の映り込み）。後処理は使わない（画面の縁は MSAA でなめらかにする） ---
  let quality: Quality = "mid";
  const opt = { shadow: true };

  // 影の絵（シャドウマップ）は、作り直さない。GPU が使っている最中の絵を壊すと、画面が止まる（クラッシュの原因になる）。
  // 影の「なし」も、光の影をやめるのではなく、濃さ 0 にして描き直しを止めるだけにする
  // （光の影を切り替えると、全部の材質のシェーダーが作り直しになり、数秒止まる）
  sun.shadow.mapSize.set(512, 512); // 影の絵は粗くてよい（建物が大きく、縁がぼやけても違和感がない。軽くもなる）
  sun.castShadow = true;
  let shadowOn = true;

  const setQuality = (q: Quality) => {
    quality = q;
    shadowOn = q !== "low" && opt.shadow;
    sun.shadow.intensity = shadowOn ? 1 : 0;
    shadowDirty = true;
  };

  const tmp = new THREE.Vector3();
  const center = new THREE.Vector3();
  const shadowCenter = new THREE.Vector3(1e9, 0, 1e9);
  let shadowStamp = 0;
  let shadowDirty = true;
  let shadowRedraws = 0;
  let shadowFrozen = false;
  const shadowEvery = qs.get("shadowsync") === "1"; // ?shadowsync=1 で従来どおり毎コマ描く（比較用）
  sun.shadow.autoUpdate = shadowEvery;

  const update = () => {
    sky.position.copy(camera.position);
    clouds.position.copy(camera.position);
    // 影の範囲: カメラの真下を中心にする（向きを変えても動かない）。
    // 以前は「向いている先」を中心にしていたので、視点を回すたびに影の絵を丸ごと描き直して、ガクッと引っかかっていた
    const R = isMobile ? 200 : 240;
    center.set(camera.position.x, 0, camera.position.z);
    const texel = (2 * R) / sun.shadow.mapSize.x;
    center.x = Math.round(center.x / texel) * texel;
    center.z = Math.round(center.z / texel) * texel;
    const cam = sun.shadow.camera;
    if (cam.right !== R) {
      cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
      cam.updateProjectionMatrix();
    }
    // 影の絵は毎コマ描き直さない（中・高画質が重い主な理由）。カメラが 70m 動いたとき、または 4 秒ごと、
    // 切り替え直後にだけ描き直す。描き直すときに太陽の位置も一緒に動かすので、影がずれて見えることはない。
    const now = performance.now();
    if (shadowOn && !shadowFrozen && (shadowEvery || shadowDirty || center.distanceTo(shadowCenter) > (isMobile ? 35 : 50) || now - shadowStamp > 6000)) {
      shadowRedraws++;
      shadowCenter.copy(center);
      shadowStamp = now;
      shadowDirty = false;
      sun.target.position.copy(center);
      sun.position.copy(center).addScaledVector(sunDir, 900);
      sun.target.updateMatrixWorld();
      sun.shadow.needsUpdate = true;
    }
    void tmp;
  };

  const render = () => {
    renderer.render(scene, camera);
  };

  setQuality(quality);

  const setOptions: Look["setOptions"] = (o) => {
    Object.assign(opt, o);
    setQuality(quality);
  };

  return {
    group,
    get quality() { return quality; },
    set quality(q: Quality) { setQuality(q); },
    setQuality,
    update,
    render,
    setOptions,
    freezeShadow: (b: boolean) => { shadowFrozen = b; },
    shadowRedraws: () => shadowRedraws,
    groundMaterial,
    sunDir,
  } as Look;
}
