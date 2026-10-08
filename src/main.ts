// 性能チェック用ページ（M0 の最初の一歩）。
// 街の代わりに、たくさんの箱を並べて、何コマ/秒出るかを画面に表示する。
// WebGPU が使えれば WebGPU、使えなければ WebGL 2 で動く。
import * as THREE from "three/webgpu";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

async function gpuName(): Promise<string> {
  try {
    const gpu = (navigator as any).gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      const info = adapter?.info;
      if (info) {
        const s = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ");
        if (s) return s;
      }
    }
  } catch { /* 取れなくても続ける */ }
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch { /* 同上 */ }
  return "不明";
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.prepend(renderer.domElement);
  await renderer.init();

  const isWebGPU = (renderer.backend as any).isWebGPUBackend === true;
  $("backend").textContent = isWebGPU ? "WebGPU（新しい方式）" : "WebGL 2（互換方式）";
  gpuName().then((n) => ($("gpu").textContent = n));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ec9ff);
  scene.fog = new THREE.Fog(0x9ec9ff, 200, 1400);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 3000);

  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x6b8f4e, 1.2));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(300, 500, 200);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ color: 0x7fae5b }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  let city: THREE.InstancedMesh | null = null;
  function buildCity(count: number) {
    if (city) {
      scene.remove(city);
      city.geometry.dispose();
      (city.material as THREE.Material).dispose();
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    city = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff }), count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    // 疑似乱数（毎回同じ街になる）
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const side = Math.ceil(Math.sqrt(count));
    const pitch = 3000 / side;
    for (let i = 0; i < count; i++) {
      const x = (i % side) * pitch - 1500 + (rnd() - 0.5) * pitch * 0.3;
      const z = Math.floor(i / side) * pitch - 1500 + (rnd() - 0.5) * pitch * 0.3;
      const h = 8 + Math.pow(rnd(), 3) * 120;
      const w = pitch * (0.35 + rnd() * 0.3);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 0.2);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(w, h, w));
      city.setMatrixAt(i, m);
      color.setHSL(0.08 + rnd() * 0.12, 0.25 + rnd() * 0.25, 0.55 + rnd() * 0.25);
      city.setColorAt(i, color);
    }
    scene.add(city);
  }
  buildCity(20000);

  document.querySelectorAll<HTMLButtonElement>("#panel button").forEach((b) => {
    b.addEventListener("click", () => {
      buildCity(Number(b.dataset.n));
      document.querySelectorAll("#panel button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    });
  });
  document.querySelector<HTMLButtonElement>('button[data-n="20000"]')!.classList.add("on");

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    $("res").textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;
  });
  $("res").textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;

  // FPS 計測（直近 1 秒の平均と、最も長かった 1 コマ）
  let frames = 0, acc = 0, worst = 0, last = performance.now(), t = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    frames++; acc += dt; worst = Math.max(worst, dt); t += dt / 1000;
    if (acc >= 1000) {
      $("fps").textContent = String(Math.round((frames * 1000) / acc));
      $("ms").textContent = `（最長 ${worst.toFixed(0)} ms）`;
      frames = 0; acc = 0; worst = 0;
    }
    // 街の上空をゆっくり周回
    const r = 500;
    camera.position.set(Math.cos(t * 0.15) * r, 90, Math.sin(t * 0.15) * r);
    camera.lookAt(0, 20, 0);
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  $("backend").textContent = "エラー: " + (e?.message ?? e);
  console.error(e);
});
