// 数値の出典は docs/parameters.md（唯一の真実）。
// ここは Phase 1 で使う分をコードに取り込んだもの。
// (補正) と付けたものは、parameters.md の単位のままでは
// 「1日=60秒」の sim 時間に合わないため調整した係数。headless で再調整する。

export const CFG = {
  // 1. ワールド
  WORLD_SIZE_M: 512,
  TERRAIN_CELLS: 256,
  CELL_M: 2,
  HEIGHT_MIN: -20,
  HEIGHT_MAX: 120,
  SEA_LEVEL: 0,
  SPATIAL_HASH_CELL: 8,

  // 2. 時間
  SIM_HZ: 60,
  STEP_TICKS: 4, // (補正) 4 tick(=1/15秒) ごとにエージェントを更新。性能優先
  DAY_SECONDS: 60, // ゲーム内1日 = 実時間60秒
  DAYS_PER_SEASON: 30,
  SEASONS_PER_YEAR: 4,
  SPEED_OPTIONS: [0, 0.25, 1, 2, 4, 16, 64],

  // 3. 気候
  BASE_TEMP: 18,
  LAPSE_RATE: 0.65,
  SEASONAL_AMPLITUDE: 12,

  // 4. 植物（草）
  GRASS_BASE_RATE: 0.035,
  CAP_GRASSLAND: 100,
  CAP_DESERT: 8,
  CAP_COLD: 15,
  CAP_FOREST: 160,
  CAP_RAINFOREST: 220,
  GRASS_TEMP_OPT: 20,
  GRASS_TEMP_MIN: 0,
  GRASS_TEMP_MAX: 45,
  GRASS_NUTRIENT_HALF: 0.3,
  OVERGRAZE_THRESHOLD: 0.15,
  OVERGRAZE_RECOVERY_MUL: 0.2,
  GRASS_SEED_BANK: 0.02, // (補正) 焼けた後の再生を保証する種子バンク

  // 5. エネルギー・代謝
  ENERGY_SCALE: 44, // (補正) 内部エネルギー単位への換算係数
  ENERGY_PER_GRASS_UNIT: 0.9,
  BMR_COEF: 0.9,
  MOVE_COST_COEF: 0.35,
  MOVE_COST_SCALE: 0.15, // (補正) 移動コストの総合係数。parameters.md の式のままだと基礎代謝の数倍になり餓死が暴走する
  SWIM_COST_MUL: 2.2,
  THERMO_COST_COEF: 0.8,
  REPRO_THRESHOLD: 0.6,
  REPRO_HEALTH_MIN: 40,
  STARVE_DAMAGE: 3.0,
  HYDRATION_DRAIN_PER_DAY: 12,
  DRINK_PER_DAY: 120, // (仮) 水辺での回復量
  GRAZE_UNTIL: 0.9, // この満腹度未満なら採食を続ける
  DRINK_UNTIL: 75, // 一度水飲みを始めたら、この水分量まで続ける（ヒステリシス）
  THIRST_THRESHOLD: 45, // 水分がこれ未満で水を飲みに行く（早めに行かないと遠征で餓死する）
  GRAZE_BITE_PER_STEP: 0.1, // (補正) 1 step あたりの採食量（バイオマス単位）
  GRAZE_MIN_GRASS: 0.05, // この量以上の草があれば足元で食べる

  // 6. 体温
  COMFORT_TEMP_LOW: 5,
  COMFORT_TEMP_HIGH: 32,
  FUR_INSULATION: 1.5,

  // 7. 移動
  BASE_MAX_SPEED: 6.0,
  BASE_TURN_RATE: 3.0,
  SLOPE_MAX: 0.9,
  SLOPE_PENALTY_COEF: 1.5,
  SWIM_DEPTH_TRIGGER: 0.5,
  DROWN_DEPTH: 1.0,
  DROWN_DAMAGE: 6.0,
  DEEP_WATER: 1.0,

  // 8. 感覚（Phase 1 は配偶者探索のみ）
  MATE_SEARCH_RADIUS: 40,
  MATE_RADIUS: 3.0,
  MATE_COOLDOWN_DAYS: 20, // (補正) 5日では増殖が速すぎて草が追いつかない。繁殖間隔は約1/6年

  // 10. 繁殖・遺伝（Phase 1 は遺伝子なし。形質は親の平均＋ノイズ）
  OFFSPRING_ENERGY_SHARE: 0.3,
  MATURITY_YEARS: 1.5,
  MAX_AGE_YEARS: 8,
  JUVENILE_SIZE_MUL: 0.4,
  JUVENILE_SPEED_MUL: 0.7,
  MUTATION_SIGMA: 0.08,
  MUTATION_JUMP_PROB: 0.005,
  MUTATION_JUMP_SIGMA: 0.35,
  STRESS_POP: 30,

  // 11. 種
  MIN_POP_WARNING: 12,

  // 14. 上限・安全弁
  MAX_AGENTS: 8192,
  SOFT_AGENT_CAP: 6000,

  // 初期プリセット herbivore_starter（mass 40kg, legLength 0.9m, fur 0.3）
  START_HERBIVORES: 80,
  PRESET_HERB: { mass: 40, leg: 0.9, fur: 0.3, hue: 0.1 },

  // 12. 捕食者（Phase 2 の肉食獣。parameters.md の carnivore_starter から mass / leg / fur を採用）
  START_CARNIVORES: 4, // (仮) 初期数
  PRESET_CARN: { mass: 55, leg: 1.0, fur: 0.2, hue: 0.0 },
  CARN_MAX: 300, // (仮) 肉食獣の上限
  CARN_SIGHT: 30, // (仮) 獲物を見つける距離 [m]
  CARN_ATTACK_RANGE: 1.8, // (仮) 攻撃が届く距離 [m]
  CARN_CATCH_CHANCE: 0.015, // (仮) 接触 1 step あたりの捕獲確率（捕食圧 1.0 のとき）
  CARN_MEAT_SHARE: 1.0, // (仮) 獲物の最大エネルギーのうち食べられる割合
  CARN_MATE_COOLDOWN_DAYS: 25, // (仮)
  CARN_MATE_SIGHT: 600, // (仮) 肉食獣が交配相手を探す距離 [m]（個体数が少ないため広めに探す）
  CARN_PREY_HALF: 5, // (仮) 捕獲効率の半減個体数（近くの獲物が少ないと狩りが失敗しやすい：獲物の避難効果）
  CARN_HANDLING_DAYS: 2.0, // (仮) 捕食後の消化時間。この間は狩りをしない（Holling II の取り扱い時間）
  CARN_SPEED_MUL: 1.0, // (仮) 最大速度の草食獣比（狩り時）
  CARN_BMR_MUL: 0.5,
  CARN_MOVE_MUL: 0.3, // (仮) 肉食獣の移動コスト倍率（待ち伏せ型で走り続けない前提）
  HERB_SIGHT: 25, // (仮) 草食獣が捕食者を察知する距離 [m]
  HERB_FLEE_SPEED: 1.25, // 逃走時の速度（最大速度比）

  // 13. 気候の操作（Phase 4 の気候スライダー・イベント）。既定値は「なし」
  CLIM_TEMP_MIN: -10,
  CLIM_TEMP_MAX: 10,
  CLIM_RAIN_MIN: 0.2,
  CLIM_RAIN_MAX: 2.5,
  CLIM_SEASON_MIN: 0,
  CLIM_SEASON_MAX: 24,
  PREDATION_MAX: 2,
  EVT_COLD_TEMP: -10, EVT_COLD_DAYS: 30, // 寒波
  EVT_HEAT_TEMP: 8, EVT_HEAT_DAYS: 20, // 熱波
  EVT_DROUGHT_RAIN: 0.3, EVT_DROUGHT_DAYS: 120, // 干ばつ
  EVT_FLOOD_RAIN: 2.5, EVT_FLOOD_DAYS: 15, // 豪雨
  EVT_METEOR_RADIUS: 80, // 隕石の被害半径 [m]
  EVT_METEOR_COOL: -6, EVT_METEOR_DAYS: 240, // 粉塵による寒冷化
  EVT_PLAGUE_KILL: 0.35, // 疫病で草食獣が死ぬ割合
  EVT_PLAGUE_CARN_KILL: 0.2,
} as const;

export const DAY_TICKS = CFG.SIM_HZ * CFG.DAY_SECONDS; // 3600
export const DAY_STEPS = DAY_TICKS / CFG.STEP_TICKS; // 900
export const STEP_DT = CFG.STEP_TICKS / CFG.SIM_HZ; // 秒
export const DAYS_PER_YEAR = CFG.DAYS_PER_SEASON * CFG.SEASONS_PER_YEAR; // 120
