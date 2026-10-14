// メインスレッド ⇔ Worker の型定義（spec §11.2 の Phase 1 版）。

export type Command =
  | { type: 'init'; seed: number }
  | { type: 'reset'; seed: number }
  | { type: 'frame'; dtMs: number }
  | { type: 'speed'; value: number }
  | { type: 'burn'; x: number; z: number; r: number }
  | { type: 'spawn'; x: number; z: number; n: number; kind: 'herb' | 'carn' }
  | { type: 'select'; slot: number }
  | { type: 'event'; kind: EventKind; x: number; z: number }
  | { type: 'settings'; temp: number; rain: number; season: number; predation: number }
  | { type: 'mode'; controller: 'fsm' | 'brain'; learning: boolean };

/** 系統樹の 1 行（生存数つき）。 */
export interface SpeciesRow {
  id: number;
  depth: number;
  text: string;
  alive: number;
}

/** プレイヤーが起こす気候イベント（Phase 4）。 */
export type EventKind = 'cold' | 'heat' | 'drought' | 'flood' | 'meteor' | 'plague';
export const EVENT_LABELS: Record<EventKind, string> = {
  cold: '寒波',
  heat: '熱波',
  drought: '干ばつ',
  flood: '豪雨',
  meteor: '隕石',
  plague: '疫病',
};

export interface DayRecord {
  day: number;
  year: number;
  pop: number;
  meanMass: number;
  meanLeg: number;
  meanFur: number;
  meanEnergy: number;
  grassRatio: number;
  births: number;
  starve: number;
  thirst: number;
  old: number;
  heat: number;
  drown: number;
  predators: number;
  predated: number;
  disease: number;
  impact: number;
  carnDeaths: number;
  species: number;
}

export interface Status {
  day: number;
  year: number;
  doy: number;
  season: number;
  pop: number;
  predators: number;
  extinct: boolean;
  seed: number;
  speed: number;
  tick: number;
}

export interface Selected {
  brainIn: number[];
  brainOut: number[];
  activeH: number;
  species: string;
  speciesId: number;
  genes: Record<string, number>;
  plasticity: number;
  ageYears: number;
  slot: number;
  mass: number;
  leg: number;
  fur: number;
  hue: number;
  energy: number; // 0..1
  health: number;
  hydration: number;
  age: number; // 日
  state: string;
  speed: number;
}

/** 数値の並びは草食獣と同じ（pdata）。 */
/** data の 1 個体あたりの要素数 */
export const STRIDE = 9;
// data 配列の並び: x, groundY, z, heading, sizeFactor, leg, fur, hue, energyFrac

export type WorkerOut =
  | {
      type: 'terrain';
      vertH: Float32Array;
      biome: Uint8Array;
      sea: number;
      seed: number;
      grassRatio: Float32Array;
    }
  | {
      type: 'snapshot';
      status: Status;
      ids: Int32Array;
      data: Float32Array;
      states: Uint8Array;
      pdata: Float32Array;
      pstates: Uint8Array;
      grassRatio: Float32Array | null;
      species: SpeciesRow[] | null;
      days: DayRecord[];
      events: string[];
      selected: Selected | null;
    };
