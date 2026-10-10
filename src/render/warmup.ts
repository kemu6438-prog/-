// 「初めて描く組み合わせ」の準備を、画面を止めずに先に済ませる。
//
// 背景: 描画の命令（材質 × 形の持ち物の並び方）を GPU に初めて出すとき、ドライバーが専用のプログラムを作る。
// これが数百 ミリ秒〜数秒かかり、その間は画面が止まる（実機のログで、描画命令 779 ms や 1〜4 秒の止まりとして出ていた）。
// 同じ組み合わせは 2 回目からは一瞬。だから「初めて」を、見せる前に、裏でやっておく。
//
// 使い方:  ready(mesh, material) が true になってから見せる。false なら request() して待つ。
//  ・本物の形は使わず、同じ「持ち物の並び方」の小さな身代わり（三角形 1 つ）で準備する（本物の形を触らない）。
//  ・準備は 1 つずつ順番に。10 秒たっても終わらなければ諦めて「済み」にする（見えなくなるよりまし）。
import * as THREE from "three/webgpu";

type Compiler = { compileAsync(obj: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<unknown> };

/** 身代わりの形: 属性の名前・要素数・型・インスタンス設定が同じで、中身は三角形 1 つ。作れなければ null */
function twinGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const t = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(g.attributes)) {
    const ba = a as THREE.BufferAttribute & { isInterleavedBufferAttribute?: boolean; isInstancedBufferAttribute?: boolean; meshPerAttribute?: number; gpuType?: number };
    if (ba.isInterleavedBufferAttribute) return null;
    const Ctor = ba.array.constructor as new (n: number) => ArrayLike<number> & ArrayBufferView;
    let nb: THREE.BufferAttribute;
    if (ba.isInstancedBufferAttribute) {
      nb = new THREE.InstancedBufferAttribute(new Ctor(ba.itemSize) as never, ba.itemSize, ba.normalized, ba.meshPerAttribute ?? 1);
    } else {
      nb = new THREE.BufferAttribute(new Ctor(ba.itemSize * 3) as never, ba.itemSize, ba.normalized);
    }
    if (ba.gpuType !== undefined) nb.gpuType = ba.gpuType as never;
    t.setAttribute(name, nb);
  }
  if (g.index) {
    const IC = g.index.array.constructor as new (n: number) => Uint16Array | Uint32Array;
    const ia = new IC(3);
    ia[1] = 1; ia[2] = 2;
    t.setIndex(new THREE.BufferAttribute(ia, 1));
  }
  return t;
}

/** 形の「持ち物の並び方」を表す文字（three.js の内部の区別と同じ材料） */
function layoutKey(g: THREE.BufferGeometry): string {
  let k = "";
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name] as THREE.BufferAttribute & { isInterleavedBufferAttribute?: boolean; meshPerAttribute?: number };
    k += `${name}:${a.itemSize}${a.normalized ? "n" : ""}${a.array.constructor.name}${a.isInterleavedBufferAttribute ? "i" : ""}${a.meshPerAttribute ?? ""},`;
  }
  return k + (g.index ? `idx${g.index.array.constructor.name}` : "");
}

export class Warmup {
  private readonly done = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  completed = 0;
  /** 準備にかかった時間（ms）の最大・合計（確認用） */
  maxMs = 0;
  totalMs = 0;
  private logged = 0;
  enabled = new URLSearchParams(location.search).get("warm") !== "0";

  constructor(
    private readonly renderer: Compiler,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly log: (m: string) => void,
  ) {}

  get waiting() { return this.pending; }

  private key(mesh: THREE.Mesh, material: THREE.Material): string {
    const im = mesh as THREE.InstancedMesh;
    // three.js は、インスタンス（同じ形を大量に並べる物）を 1 つずつ別の組み合わせとして扱う（内部の鍵に物の識別子が入る）。
    // なので、インスタンスは本物を 1 つずつ準備する。ふつうの物は、同じ組み合わせをまとめて 1 回で済ませる
    if (im.isInstancedMesh) return `I|${mesh.uuid}|${material.uuid}`;
    return `${material.uuid}|M|${mesh.receiveShadow ? "r" : ""}|${layoutKey(mesh.geometry)}`;
  }

  /** 本物がまだ画面のツリーにつながっているか（捨てられた物を準備しないため） */
  private attached(o: THREE.Object3D): boolean {
    let p: THREE.Object3D = o;
    while (p.parent) p = p.parent;
    return p === (this.scene as THREE.Object3D);
  }

  /** 準備済み（または準備しなくてよい）なら true */
  ready(mesh: THREE.Mesh, material: THREE.Material): boolean {
    return !this.enabled || this.done.has(this.key(mesh, material));
  }

  /** 準備を頼む（すでに頼んであれば、それを待つ）。終わったら解決する（失敗・時間切れでも解決する） */
  request(mesh: THREE.Mesh, material: THREE.Material): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const key = this.key(mesh, material);
    if (this.done.has(key)) return Promise.resolve();
    const have = this.inflight.get(key);
    if (have) return have;
    const im = mesh as THREE.InstancedMesh;
    const direct = im.isInstancedMesh === true;
    let twin: THREE.BufferGeometry | null = null;
    let proxy: THREE.Mesh | null = null;
    if (!direct) {
      twin = twinGeometry(mesh.geometry);
      proxy = new THREE.Mesh(twin ?? mesh.geometry, material);
      proxy.frustumCulled = false; // 画面の外でも準備する
      proxy.receiveShadow = mesh.receiveShadow;
      proxy.castShadow = false;
    }
    this.pending++;
    const job = this.chain.then(async () => {
      const t0 = performance.now();
      try {
        if (direct) {
          // 本物を準備する。画面の外・隠れていても対象にするため、一瞬だけ「必ず対象」にする（呼び出しの前半は同期で終わる）
          if (this.attached(mesh)) {
            const fc = mesh.frustumCulled, vis = mesh.visible, mat = mesh.material;
            mesh.frustumCulled = false; mesh.visible = true; mesh.material = material;
            const p = this.renderer.compileAsync(mesh, this.camera, this.scene);
            mesh.frustumCulled = fc; mesh.visible = vis; mesh.material = mat;
            await Promise.race([p, new Promise((r) => setTimeout(r, 10000))]);
          }
        } else {
          await Promise.race([
            this.renderer.compileAsync(proxy!, this.camera, this.scene),
            new Promise((r) => setTimeout(r, 10000)),
          ]);
        }
      } catch (e) {
        if (this.logged++ < 3) this.log(`描画の準備でエラー（無視して続行）: ${(e as Error)?.message ?? e}`);
      }
      const dt = performance.now() - t0;
      this.totalMs += dt;
      this.maxMs = Math.max(this.maxMs, dt);
      if (dt > 150 && this.logged < 25) { this.logged++; this.log(`描画の準備（初めての組み合わせ）: ${dt.toFixed(0)} ms かかった（裏で実行。画面は止まらない）`); }
      twin?.dispose();
      this.done.add(key);
      this.inflight.delete(key);
      this.pending--;
      this.completed++;
    });
    this.chain = job;
    this.inflight.set(key, job);
    return job;
  }
}
