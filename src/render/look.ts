// 画面全体の「絵作り」: 空・太陽の光と影・空の映り込み・暗がり・光のにじみ・遠くのかすみ。
// 画質は 低 / 中 / 高 から選べる（重いときは下げる）。
import { TEX } from "./assets";
import * as THREE from "three/webgpu";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { float, length, mix, mrt, normalView, output, pass, positionView, positionWorld, renderOutput, saturation, smoothstep, vec2, vec3, vec4 } from "three/tsl";
import { vnoise, type N } from "./noise";

export type Quality = "low" | "mid" | "high";

export type Look = {
  group: THREE.Group;
  quality: Quality;
  setQuality(q: Quality): void;
  /** 毎コマ、カメラの位置に合わせて空と影を動かす */
  update(): void;
  render(): void;
  /** 性能の切り分け用: 影・暗がり(AO)・光のにじみと縁のなめらか化 を個別に切る */
  setOptions(o: Partial<{ shadow: boolean; ao: boolean; post: boolean }>): void;
  groundMaterial: THREE.MeshStandardNodeMaterial;
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
  sky.cloudCoverage.value = 0.45;
  sky.sunPosition.value.copy(sunDir);
  group.add(sky);

  // --- 空の映り込み用の環境（太陽の円盤は消して作る） ---
  const envScene = new THREE.Scene();
  const envSky = new SkyMesh();
  envSky.scale.setScalar(SKY_RADIUS);
  envSky.turbidity.value = sky.turbidity.value;
  envSky.rayleigh.value = sky.rayleigh.value;
  envSky.mieCoefficient.value = sky.mieCoefficient.value;
  envSky.mieDirectionalG.value = sky.mieDirectionalG.value;
  envSky.cloudCoverage.value = sky.cloudCoverage.value;
  envSky.sunPosition.value.copy(sunDir);
  envSky.showSunDisc.value = 0;
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0, 1, SKY_RADIUS * 2);
  scene.environment = envRT.texture;
  scene.environmentIntensity = num("env", 0.22);

  // --- 光 ---
  const hemi = new THREE.HemisphereLight(0xe6efff, 0x9a8f78, 0.14);
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // --- 地面（芝とコンクリートのまだら。道路を作るまでの仮） ---
  const groundMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  {
    const p: N = vec2(positionWorld.x, positionWorld.z);
    const dist: N = length(positionView as N);
    const near: N = float(1.0).sub(smoothstep(15.0, 140.0, dist)); // 近くだけ細かい粒を出す（遠くのちらつき防止）
    const n1: N = vnoise(p.mul(0.012));
    const n2: N = vnoise(p.mul(0.35));
    const n3: N = vnoise(p.mul(2.6));
    const g1: N = vnoise(p.mul(22.0));
    const g2: N = vnoise(p.mul(70.0));
    const grass: N = mix(vec3(0.27, 0.42, 0.18), vec3(0.4, 0.5, 0.22), n1);
    // 道路の外の地面（敷地・広場・歩道のすき間）: 明るめのコンクリートと砂利、ところどころ芝。
    // 道路そのものは roads.ts の専用の面で描くので、ここは「道路以外」の色。
    const lot: N = mix(vec3(0.42, 0.41, 0.39), vec3(0.54, 0.52, 0.48), n2)
      .mul(float(0.9).add(g1.mul(0.22).mul(near)).add(g2.mul(0.14).mul(near)));
    const k: N = smoothstep(0.62, 0.78, n1);
    groundMaterial.colorNode = mix(lot.mul(TEX.concrete.detail2(p)), grass, k).mul(n3.mul(0.14).add(0.93));
  }

  // --- 画質ごとの組み立て ---
  let pipeline: THREE.RenderPipeline | null = null;
  let quality: Quality = isMobile ? "mid" : "high";
  const opt = { shadow: true, ao: true, post: true };

  const applyShadow = (size: number) => {
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  };

  const buildPipeline = () => {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const col: N = scenePass.getTextureNode("output");
    const nor: N = scenePass.getTextureNode("normal");
    const dep: N = scenePass.getTextureNode("depth");
    const aoPass = ao(dep, nor, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.radius.value = 2.5;
    aoPass.thickness.value = 2.0;
    aoPass.samples.value = 12;
    // 暗がりは強くなりすぎないよう下限を設ける（細かい黒ノイズの対策）
    const occl: N = opt.ao ? mix(1.0, (aoPass.getTextureNode() as N).r, 0.8).max(0.5) : float(1.0);
    const lit: N = vec4(saturation((col as N).rgb.mul(occl), num("sat", 1.18)), (col as N).a);
    const glow: N = bloom(lit, num("bloom", 0.12), 0.5, 1.2);
    const rp = new THREE.RenderPipeline(renderer);
    rp.outputColorTransform = false;
    rp.outputNode = opt.post ? fxaa(renderOutput(lit.add(glow))) : renderOutput(lit);
    return rp;
  };

  const setQuality = (q: Quality) => {
    quality = q;
    shadowDirty = true;
    sun.castShadow = q !== "low" && opt.shadow;
    applyShadow(q === "high" && !isMobile ? 2048 : 1024);
    if (q === "high") {
      if (!pipeline) {
        try {
          pipeline = buildPipeline();
        } catch (e) {
          log("高画質の後処理を作れなかった（中画質で続行）: " + ((e as Error)?.message ?? e));
          quality = "mid";
          pipeline = null;
        }
      }
    } else {
      pipeline?.dispose?.();
      pipeline = null;
    }
  };

  const tmp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const center = new THREE.Vector3();
  const shadowCenter = new THREE.Vector3(1e9, 0, 1e9);
  let shadowStamp = 0;
  let shadowDirty = true;
  const shadowEvery = qs.get("shadowsync") === "1"; // ?shadowsync=1 で従来どおり毎コマ描く（比較用）
  sun.shadow.autoUpdate = shadowEvery;

  const update = () => {
    sky.position.copy(camera.position);
    // 影の範囲: カメラが向いている先の地面まわり（影の粒が荒くならないよう小さな範囲を追う）
    const R = isMobile ? 220 : 300;
    camera.getWorldDirection(fwd);
    const t = fwd.y < -0.05 ? Math.min(-camera.position.y / fwd.y, R * 1.1) : R * 0.4;
    center.copy(camera.position).addScaledVector(fwd, t);
    center.y = 0;
    const texel = (2 * R) / sun.shadow.mapSize.x;
    center.x = Math.round(center.x / texel) * texel;
    center.z = Math.round(center.z / texel) * texel;
    const cam = sun.shadow.camera;
    if (cam.right !== R) {
      cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
      cam.updateProjectionMatrix();
    }
    // 影の絵は毎コマ描き直さない（中・高画質が重い主な理由）。注目点が 25m ずれたとき、または 1.5 秒ごと、
    // 切り替え直後にだけ描き直す。描き直すときに太陽の位置も一緒に動かすので、影がずれて見えることはない。
    const now = performance.now();
    if (shadowEvery || shadowDirty || center.distanceTo(shadowCenter) > 25 || now - shadowStamp > 1500) {
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
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
  };

  setQuality(quality);

  const setOptions: Look["setOptions"] = (o) => {
    Object.assign(opt, o);
    pipeline?.dispose?.();
    pipeline = null;
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
    groundMaterial,
  } as Look;
}
