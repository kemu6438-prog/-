// 3D ビューポート（Three.js）。描画だけを担当し、シミュレーションの状態は持たない。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG } from '../sim/config';
import { BIOME } from '../sim/world';
import { STRIDE } from '../sim/protocol';

const N = CFG.TERRAIN_CELLS;
const V = N + 1;
const S = CFG.CELL_M;
const MAX_DRAW = CFG.MAX_AGENTS;
// 見やすさのための表示倍率（シミュレーションのサイズには影響しない）
const VIS = 2.2;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private terrainMesh: THREE.Mesh | null = null;
  private terrainGeom: THREE.BufferGeometry | null = null;
  private colorAttr: THREE.BufferAttribute | null = null;
  private vertH: Float32Array = new Float32Array(V * V);
  private biome: Uint8Array = new Uint8Array(N * N);
  private sea: number = CFG.SEA_LEVEL;
  private waterMesh: THREE.Mesh;
  private bodyMesh: THREE.InstancedMesh;
  private legMesh: THREE.InstancedMesh;
  private predBody: THREE.InstancedMesh;
  private predLeg: THREE.InstancedMesh;
  private slots: Int32Array = new Int32Array(0);
  private count = 0;
  private keys = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private readonly dry = new THREE.Color('#a88f5a');
  private readonly lush = new THREE.Color('#4f8f3a');
  private readonly sand = new THREE.Color('#d9c58f');
  private readonly snow = new THREE.Color('#eef4f7');
  private readonly rock = new THREE.Color('#7d7a72');
  private readonly beach = new THREE.Color('#d8c9a0');
  private readonly deep = new THREE.Color('#1b3f6b');
  private readonly shallow = new THREE.Color('#5aa6c9');

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#bfd9ec');
    this.scene.fog = new THREE.Fog('#bfd9ec', 500, 1500);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.5, 3000);
    this.camera.position.set(256 + 170, 140, 256 + 170);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(256, 0, 256);
    this.controls.enableDamping = true;
    // 左ドラッグは観察・ツール用に空けておき、回転は右ドラッグにする
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 1000;
    this.controls.update();

    const hemi = new THREE.HemisphereLight('#dff1ff', '#3a3020', 1.0);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
    sun.position.set(300, 400, 180);
    this.scene.add(sun);

    const waterGeom = new THREE.PlaneGeometry(CFG.WORLD_SIZE_M, CFG.WORLD_SIZE_M);
    waterGeom.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({ color: '#2a72b8', transparent: true, opacity: 0.55, roughness: 0.25 });
    this.waterMesh = new THREE.Mesh(waterGeom, waterMat);
    this.waterMesh.position.set(256, CFG.SEA_LEVEL, 256);
    this.scene.add(this.waterMesh);

    // 草食獣：胴＋頭（1メッシュ）と脚（別メッシュ）。脚長・体格・体色が形質に対応する
    const bodyBox = new THREE.BoxGeometry(0.5, 0.45, 1.1);
    const headBox = new THREE.BoxGeometry(0.35, 0.35, 0.35);
    headBox.translate(0, 0.12, 0.7);
    const bodyGeom = mergeGeometries([bodyBox, headBox])!;
    const legGeoms: THREE.BufferGeometry[] = [];
    for (const [lx, lz] of [
      [-0.18, -0.4],
      [0.18, -0.4],
      [-0.18, 0.4],
      [0.18, 0.4],
    ] as const) {
      const g = new THREE.BoxGeometry(0.12, 1, 0.12);
      g.translate(lx, 0.5, lz);
      legGeoms.push(g);
    }
    const legGeom = mergeGeometries(legGeoms)!;
    this.bodyMesh = new THREE.InstancedMesh(bodyGeom, new THREE.MeshStandardMaterial({ roughness: 0.75 }), MAX_DRAW);
    this.legMesh = new THREE.InstancedMesh(legGeom, new THREE.MeshStandardMaterial({ color: '#3b2f25', roughness: 0.9 }), MAX_DRAW);
    // 肉食獣：同じ形状で、色と脚の目立ち方を変える
    this.predBody = new THREE.InstancedMesh(bodyGeom, new THREE.MeshStandardMaterial({ color: '#8c3b2a', roughness: 0.6 }), CFG.CARN_MAX);
    this.predLeg = new THREE.InstancedMesh(legGeom, new THREE.MeshStandardMaterial({ color: '#2a1d19', roughness: 0.9 }), CFG.CARN_MAX);
    for (const m of [this.bodyMesh, this.legMesh, this.predBody, this.predLeg]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }

    window.addEventListener('resize', () => this.resize(container));
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private resize(container: HTMLElement): void {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  /** 地形メッシュを（初回は生成し）高さを反映する。 */
  setTerrain(vertH: Float32Array, biome: Uint8Array, sea: number): void {
    this.vertH = vertH;
    this.biome = biome;
    this.sea = sea;
    if (!this.terrainGeom) {
      const pos = new Float32Array(V * V * 3);
      for (let j = 0; j < V; j++) {
        for (let i = 0; i < V; i++) {
          const k = j * V + i;
          pos[k * 3] = i * S;
          pos[k * 3 + 2] = j * S;
        }
      }
      const idx = new Uint32Array(N * N * 6);
      let p = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * V + i;
          const b = a + 1;
          const c = a + V;
          const d = c + 1;
          idx[p++] = a;
          idx[p++] = c;
          idx[p++] = b;
          idx[p++] = b;
          idx[p++] = c;
          idx[p++] = d;
        }
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      this.colorAttr = new THREE.BufferAttribute(new Float32Array(V * V * 3), 3);
      geom.setAttribute('color', this.colorAttr);
      this.terrainGeom = geom;
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this.terrainMesh = new THREE.Mesh(geom, mat);
      this.scene.add(this.terrainMesh);
    }
    const posAttr = this.terrainGeom!.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < V * V; k++) posAttr.setY(k, vertH[k]!);
    posAttr.needsUpdate = true;
    this.terrainGeom!.computeVertexNormals();
  }

  /** 草の充足率（0..1）マップで地表の色を塗る。 */
  setGrass(ratio: Float32Array): void {
    if (!this.colorAttr) return;
    const col = this.colorAttr.array as Float32Array;
    const c = this.tmpColor;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const ci = Math.min(i, N - 1);
        const cj = Math.min(j, N - 1);
        const k = cj * N + ci;
        const vk = j * V + i;
        const h = this.vertH[vk]!;
        if (h < this.sea - 0.2) {
          const depth = Math.min(1, (this.sea - h) / 12);
          c.copy(this.shallow).lerp(this.deep, depth);
        } else {
          const r = Math.min(1, ratio[k]! * 1.2);
          c.copy(this.dry).lerp(this.lush, r);
          const b = this.biome[k];
          if (b === BIOME.DESERT) c.lerp(this.sand, 0.7);
          if (b === BIOME.COLD) c.lerp(this.snow, 0.7);
          if (h - this.sea < 0.8) c.lerp(this.beach, 0.6);
          if (h > 55) c.lerp(this.rock, Math.min(1, (h - 55) / 30));
        }
        col[vk * 3] = c.r;
        col[vk * 3 + 1] = c.g;
        col[vk * 3 + 2] = c.b;
      }
    }
    this.colorAttr.needsUpdate = true;
  }

  /** スナップショットの個体データを InstancedMesh に反映する。 */
  setAgents(ids: Int32Array, data: Float32Array): void {
    const n = Math.min(ids.length, MAX_DRAW);
    this.slots = ids;
    this.count = n;
    const dummy = this.dummy;
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE;
      const x = data[o]!;
      const y = data[o + 1]!;
      const z = data[o + 2]!;
      const hd = data[o + 3]!;
      const sf = data[o + 4]!;
      const leg = data[o + 5]!;
      const fur = data[o + 6]!;
      const hue = data[o + 7]!;
      const eF = data[o + 8]!;
      // 胴
      dummy.position.set(x, y + (leg + 0.225 * sf) * VIS, z);
      dummy.rotation.set(0, hd, 0);
      dummy.scale.setScalar(sf * VIS);
      dummy.updateMatrix();
      this.bodyMesh.setMatrixAt(k, dummy.matrix);
      // 脚
      dummy.position.set(x, y, z);
      dummy.scale.set(sf * VIS, leg * VIS, sf * VIS);
      dummy.updateMatrix();
      this.legMesh.setMatrixAt(k, dummy.matrix);
      // 体色：色相は遺伝形質、明度は毛量と満腹度
      this.tmpColor.setHSL(0.05 + hue * 0.3, 0.38, (0.3 + 0.3 * fur) * (0.65 + 0.35 * eF));
      this.bodyMesh.setColorAt(k, this.tmpColor);
    }
    this.bodyMesh.count = n;
    this.legMesh.count = n;
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.legMesh.instanceMatrix.needsUpdate = true;
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
  }

  /** 肉食獣の個体データを反映する（形式は草食獣と同じ STRIDE）。 */
  setPredators(data: Float32Array, n: number): void {
    const m = Math.min(n, CFG.CARN_MAX);
    const dummy = this.dummy;
    for (let k = 0; k < m; k++) {
      const o = k * STRIDE;
      const x = data[o]!;
      const y = data[o + 1]!;
      const z = data[o + 2]!;
      const hd = data[o + 3]!;
      const sf = data[o + 4]!;
      const leg = data[o + 5]!;
      dummy.position.set(x, y + (leg + 0.225 * sf) * VIS, z);
      dummy.rotation.set(0, hd, 0);
      dummy.scale.setScalar(sf * VIS);
      dummy.updateMatrix();
      this.predBody.setMatrixAt(k, dummy.matrix);
      dummy.position.set(x, y, z);
      dummy.scale.set(sf * VIS, leg * VIS, sf * VIS);
      dummy.updateMatrix();
      this.predLeg.setMatrixAt(k, dummy.matrix);
    }
    this.predBody.count = m;
    this.predLeg.count = m;
    this.predBody.instanceMatrix.needsUpdate = true;
    this.predLeg.instanceMatrix.needsUpdate = true;
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** 画面上の点が指す地形の (x, z) を返す。 */
  pickTerrain(clientX: number, clientY: number): { x: number; z: number; h: number } | null {
    if (!this.terrainMesh) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    return { x: hit.point.x, z: hit.point.z, h: hit.point.y };
  }

  /** 画面上の点が指す草食獣のスロット番号（なければ -1）。 */
  pickAgent(clientX: number, clientY: number): number {
    if (this.count === 0) return -1;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.raycaster.intersectObject(this.bodyMesh, false)[0];
    if (!hit || hit.instanceId === undefined) return -1;
    return this.slots[hit.instanceId] ?? -1;
  }

  /** 毎フレーム：WASD で視点移動、カメラ更新、描画。 */
  frame(dt: number): void {
    const speed = (this.keys.has('shift') ? 260 : 120) * dt * (this.camera.position.y / 120 + 0.3);
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 0) fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (this.keys.has('w')) move.add(fwd);
    if (this.keys.has('s')) move.sub(fwd);
    if (this.keys.has('d')) move.add(right);
    if (this.keys.has('a')) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }
    if (this.keys.has('q')) {
      this.camera.position.y += speed * 0.6;
      this.controls.target.y += speed * 0.6;
    }
    if (this.keys.has('e')) {
      this.camera.position.y = Math.max(3, this.camera.position.y - speed * 0.6);
      this.controls.target.y = Math.max(0, this.controls.target.y - speed * 0.6);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
