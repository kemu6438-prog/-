// ネットの無料素材（Poly Haven の CC0 テクスチャ）を、ブラウザから読み込んで使う。
// - 素材は CC0（著作権フリー）。ただし Poly Haven の配信を使うので、画面に出典を表示する。
// - 読み込めなかったら（通信できない等）、自作の模様のまま動く。止まったりしない。
// - 素材の「色」は使わず、「模様の濃淡」だけを自作の色に重ねる（街の色づかいは自作のまま、質感だけ本物になる）。
import * as THREE from "three/webgpu";
import { mix, texture, uniform, vec2, vec3 } from "three/tsl";
import type { N } from "./noise";

const placeholder = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
})();

const enabled = new URLSearchParams(location.search).get("tex") !== "0";

export class PolyTexture {
  /** 読み込めたら 1 */
  readonly on = uniform(0);
  /** 画像の平均の色（線形）。これで割って「平均 1 の濃淡」にする */
  readonly avg = uniform(new THREE.Vector3(1, 1, 1));
  private nodes: N[] = [];
  state: "未読み込み" | "読み込み中" | "成功" | "失敗" = "未読み込み";

  /** id: Poly Haven の素材名 / metres: 画像 1 枚が実際に何メートル四方か */
  constructor(readonly id: string, readonly metres: number) {}

  private sample(uvMeters: N, scale = 1): N {
    const n = texture(placeholder, uvMeters.div(this.metres * scale));
    this.nodes.push(n);
    return n.rgb as N;
  }

  /** 模様の濃淡（平均がおよそ 1 の vec3）。読み込めるまでは 1（何もしない） */
  detail(uvMeters: N): N {
    const d: N = this.sample(uvMeters).div(this.avg).clamp(0.35, 2.2);
    return mix(vec3(1, 1, 1), d, this.on);
  }

  /** 同じ模様のくり返しが目立たないよう、大きさと向きの違う 2 枚を重ねる（道路・地面用） */
  detail2(uvMeters: N): N {
    const rot: N = vec2(uvMeters.x.mul(0.8).sub(uvMeters.y.mul(0.6)), uvMeters.x.mul(0.6).add(uvMeters.y.mul(0.8))).add(17.3);
    const a: N = this.sample(uvMeters).div(this.avg).clamp(0.35, 2.2);
    const b: N = this.sample(rot, 1.37).div(this.avg).clamp(0.35, 2.2);
    return mix(vec3(1, 1, 1), a.mul(b), this.on);
  }

  load(log: (m: string) => void, size = "1k") {
    if (!enabled || this.state !== "未読み込み") return;
    this.state = "読み込み中";
    const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${size}/${this.id}/${this.id}_diff_${size}.jpg`;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const g = c.getContext("2d")!;
          g.drawImage(tex.image as CanvasImageSource, 0, 0, 32, 32);
          const px = g.getImageData(0, 0, 32, 32).data;
          const lin = (v: number) => Math.pow((v / 255 + 0.055) / 1.055, 2.4);
          let r = 0, gg = 0, b = 0;
          for (let i = 0; i < px.length; i += 4) { r += lin(px[i]); gg += lin(px[i + 1]); b += lin(px[i + 2]); }
          const n = px.length / 4;
          this.avg.value.set(Math.max(r / n, 0.01), Math.max(gg / n, 0.01), Math.max(b / n, 0.01));
        } catch {
          this.avg.value.set(0.3, 0.3, 0.3);
        }
        for (const n of this.nodes) n.value = tex;
        this.on.value = 1;
        this.state = "成功";
        log(`素材を読み込めた: ${this.id}（Poly Haven / CC0）`);
      },
      undefined,
      () => {
        this.state = "失敗";
        log(`素材を読み込めなかった: ${this.id} → 自作の模様で続行`);
      },
    );
  }
}

/** 使う素材（1 枚が実際に何 m 四方かは、Poly Haven の公開情報による） */
export const TEX = {
  /** 道路: 都会のアスファルト */
  asphalt: new PolyTexture("asphalt_03", 2.05),
  /** 歩道・地面・屋根: コンクリート */
  concrete: new PolyTexture("brushed_concrete_2", 2.5),
  /** 壁: 打ちっぱなしコンクリート */
  wall: new PolyTexture("brushed_concrete_04", 2.0),
  /** 壁: レンガ */
  brick: new PolyTexture("brick_4", 0.5),
  /** 地面の芝: 青々した芝（2m 四方） */
  grass: new PolyTexture("leafy_grass", 2.0),
};

export function loadTextures(log: (m: string) => void) {
  for (const t of Object.values(TEX)) t.load(log);
}
