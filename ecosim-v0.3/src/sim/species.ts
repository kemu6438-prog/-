// 種の分岐と系統（spec §系統・Phase 2）。遺伝的距離がしきい値を超えた子は新しい種になる。

import { DIPLOID_LEN } from './genome';

export const MAX_SPECIES = 256;

export interface SpeciesInfo {
  id: number;
  parent: number; // -1 = 始祖
  born: number; // 誕生した日（0 始まり）
  name: string;
  extinct: boolean;
}

export class SpeciesRegistry {
  readonly list: SpeciesInfo[] = [];
  /** 各種の始祖の遺伝子（相同部分のみ） */
  readonly founders = new Float32Array(MAX_SPECIES * DIPLOID_LEN);

  /** 始祖種を登録する（初期個体）。 */
  createRoot(src: Float32Array, off: number, day: number, mass: number, fur: number): number {
    return this.create(-1, src, off, day, mass, fur);
  }

  create(parent: number, src: Float32Array, off: number, day: number, mass: number, fur: number): number {
    if (this.list.length >= MAX_SPECIES) return parent;
    const id = this.list.length;
    this.founders.set(src.subarray(off, off + DIPLOID_LEN), id * DIPLOID_LEN);
    this.list.push({ id, parent, born: day, name: speciesName(id, mass, fur), extinct: false });
    return id;
  }

  get count(): number {
    return this.list.length;
  }
}

/** 体サイズと毛量から、読みやすい仮の種名を付ける。 */
export function speciesName(id: number, mass: number, fur: number): string {
  const size = mass < 25 ? '小型' : mass < 60 ? '中型' : '大型';
  const coat = fur > 0.5 ? '毛深い' : '短毛の';
  return `${size}${coat}種 #${id}`;
}

/** 系統を文字列にする（親子関係のインデント表示用）。 */
export function speciesTreeLines(list: SpeciesInfo[]): { depth: number; text: string; id: number }[] {
  const out: { depth: number; text: string; id: number }[] = [];
  const children = new Map<number, SpeciesInfo[]>();
  for (const s of list) {
    const arr = children.get(s.parent) ?? [];
    arr.push(s);
    children.set(s.parent, arr);
  }
  const walk = (p: number, depth: number) => {
    for (const s of children.get(p) ?? []) {
      out.push({ depth, id: s.id, text: `${s.name}（${(s.born / 120) | 0}年目に分岐）` });
      walk(s.id, depth + 1);
    }
  };
  walk(-1, 0);
  return out;
}
