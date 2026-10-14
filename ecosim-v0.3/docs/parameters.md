# パラメータ既定値テーブル v0.1

> 実装時はこのファイルを **唯一の真実（single source of truth）** とし、
> コード側は `src/sim/config.ts` にここから生成した定数オブジェクトを持つ。
> 値は全て「まず動く」ことを優先した初期値であり、`headless/runBatch.ts` の自動探索で更新する。

---

## 1. ワールド

| キー | 値 | 単位 | 備考 |
|---|---|---|---|
| `WORLD_SIZE_M` | 512 | m | 一辺 |
| `TERRAIN_CELLS` | 256 | cells | 一辺。セル = 2m |
| `HEIGHT_MIN` | -20 | m | |
| `HEIGHT_MAX` | 120 | m | |
| `SEA_LEVEL_DEFAULT` | 0 | m | プレイヤー変更可 (-20〜40) |
| `SPATIAL_HASH_CELL` | 8 | m | 空間ハッシュ解像度 |
| `WORLD_EDGE_MODE` | `ocean` | — | `ocean` / `wall` |

## 2. 時間

| キー | 値 | 備考 |
|---|---|---|
| `SIM_DT` | 1/60 | 秒（ゲーム内） |
| `SUBSTEP_MAX` | 4 | |
| `DAY_LENGTH_SIM_SEC` | 60 | ゲーム内1日 = 実1秒×60 |
| `DAYS_PER_SEASON` | 30 | |
| `SEASONS_PER_YEAR` | 4 | → 1年 = 120日 |
| `SPEED_OPTIONS` | [0, 0.25, 1, 2, 4, 16, 64] | |
| `SNAPSHOT_HZ` | 30 | Worker→Main の描画スナップショット頻度 |

## 3. 気候

| キー | 値 | 単位 |
|---|---|---|
| `BASE_TEMP_DEFAULT` | 18 | ℃ |
| `LAPSE_RATE` | 0.65 | ℃ / 100m |
| `SEASONAL_AMPLITUDE_DEFAULT` | 12 | ℃ |
| `DIURNAL_AMPLITUDE_DEFAULT` | 6 | ℃ |
| `BASE_RAIN_DEFAULT` | 900 | mm/年 |
| `WIND_SPEED_DEFAULT` | 4 | m/s |
| `WIND_DIR_DEFAULT` | 270 | deg |
| `OROGRAPHIC_GAIN` | 1.6 | 風上斜面の降雨倍率 |
| `OROGRAPHIC_SHADOW` | 0.45 | 風下の倍率 |
| `EVAPORATION_PER_DAY` | 0.02 | 水深比 |

### バイオーム閾値

| バイオーム | 年均気温 | 年降雨 | 生産性倍率 |
|---|---|---|---|
| 寒帯 | < 0 ℃ | any | 0.15 |
| 乾燥 | ≥ 0 ℃ | < 200 mm | 0.10 |
| 草原 | 0–22 ℃ | 200–900 mm | 1.00 |
| 森林 | 5–25 ℃ | 900–1800 mm | 1.60 |
| 熱帯雨林 | > 22 ℃ | > 1800 mm | 2.20 |

## 4. 植物

| キー | 値 | 備考 |
|---|---|---|
| `GRASS_BASE_RATE` | 0.035 | /日 |
| `GRASS_CARRYING_CAP_GRASSLAND` | 100 | バイオマス単位 |
| `GRASS_CARRYING_CAP_DESERT` | 8 | |
| `GRASS_TEMP_OPT` | 20 | ℃ |
| `GRASS_TEMP_MIN` | 0 | ℃（成長0） |
| `GRASS_TEMP_MAX` | 45 | ℃（成長0） |
| `GRASS_WATER_OPT` | [0.30, 0.80] | 土壌水分 |
| `GRASS_SHADE_FACTOR` | 0.7 | 木密度1のときの光削減 |
| `GRASS_NUTRIENT_HALF` | 0.30 | soilN がこの値で f=1 |
| `OVERGRAZE_THRESHOLD` | 0.15 | carryingCap 比 |
| `OVERGRAZE_RECOVERY_MUL` | 0.2 | |
| `TREE_GROW_RATE` | 0.004 | /日 |
| `TREE_MAX_AGE_DAYS` | 3000 | |
| `LITTER_TO_SOIL_RATE` | 0.10 | /日 |
| `CORPSE_DECOMP_RATE` | 0.25 | /日 |
| `DUNG_DECOMP_RATE` | 0.60 | /日 |

## 5. エネルギー・代謝

| キー | 値 | 備考 |
|---|---|---|
| `ENERGY_PER_GRASS_UNIT` | 0.9 | kcal相当（内部単位） |
| `ENERGY_PER_MEAT_KG` | 2200 | |
| `BMR_COEF` | 0.9 | `bmr = coef * mass^0.75 * metabolismRate / 86400` |
| `MOVE_COST_COEF` | 0.35 | `cost/s = coef * mass * speed^2 / 1000` |
| `SWIM_COST_MUL` | 2.2 | |
| `BRAIN_COST_COEF` | 0.02 | `cost/s = coef * brainNeurons^1.2 * mass^0.25` |
| `THERMO_COST_COEF` | 0.8 | 適温逸脱1℃あたり |
| `GROWTH_COST_COEF` | 1.4 | 増加質量あたり |
| `REPRO_THRESHOLD` | 0.60 | max energy 比 |
| `REPRO_HEALTH_MIN` | 40 | |
| `STARVE_DAMAGE` | 3.0 | energy 0 後の health 減衰 /秒 |
| `HYDRATION_DRAIN_PER_DAY` | 12 | |
| `MAX_STOMACH_MUL` | 1.0 | `stomachCapacity * mass^0.9` |

## 6. 体温

| キー | 値 |
|---|---|
| `BODY_TEMP_INIT` | 37 ℃ |
| `THERMAL_K` | 0.012 |
| `FUR_INSULATION_MUL` | 2.5 |
| `FAT_INSULATION_MUL` | 1.8 |
| `MASS_THERMAL_EXP` | 0.4 |
| `SUN_EXPOSURE_MAX` | 8 ℃ |
| `WATER_COOLING_MUL` | 3.0 |

## 7. 移動

| キー | 値 | 備考 |
|---|---|---|
| `BASE_MAX_SPEED` | 6.0 | m/s |
| `LEG_LENGTH_SPEED_EXP` | 0.5 | |
| `FAT_SPEED_PENALTY` | 0.30 | |
| `ARMOR_SPEED_PENALTY` | 0.40 | |
| `BIPED_SPEED_BONUS` | 1.15 | |
| `BASE_ACCEL` | 12.0 | |
| `BASE_TURN_RATE` | 3.0 | rad/s |
| `SLOPE_MAX_DEFAULT` | 0.9 | (tan, ≈42°) |
| `SLOPE_PENALTY_COEF` | 1.5 | |
| `SWIM_DEPTH_TRIGGER` | 0.5 | × legLength |
| `DROWN_DEPTH` | 1.0 | × bodyHeight |
| `DROWN_DAMAGE` | 6.0 | /秒 |
| `FALL_DAMAGE_PER_M` | 4.0 | 落差2m超から |

## 8. 感覚

| キー | 値 |
|---|---|
| `VISION_RANGE_MIN/MAX` | 20 / 120 m |
| `VISION_FOV_SIDE` | 280° |
| `VISION_FOV_FRONT` | 120° |
| `SMELL_RANGE_MIN/MAX` | 30 / 200 m |
| `SMELL_WIND_FACTOR` | 2.0（風上で伸長） |
| `HEARING_RANGE_MIN/MAX` | 5 / 40 m |
| `MAX_TRACKED_TARGETS` | 3（food / threat / mate） |
| `SENSE_UPDATE_INTERVAL_FAR` | 4 tick |
| `SENSE_UPDATE_INTERVAL_NEAR` | 1 tick（カメラ近傍） |

## 9. 脳

| キー | 値 |
|---|---|
| `INPUT_DIM` | 32 |
| `OUTPUT_DIM` | 14 |
| `HIDDEN_FIXED` | 12 | 全個体共通の固定トポロジー |
| `ACTIVE_H_MIN` | 4 | brainSize=0 のときの有効ユニット数 |
| `ACTIVE_H_MAX` | 12 | brainSize=1 のとき |
| `WEIGHT_COUNT` | 696 | 32*12 + 12*12 + 12*14 |
| `BRAIN_COST_EXP` | 1.2 | `cost = coef * activeH^1.2 * mass^0.25` |
| `ACTIVATION` | tanh |
| `LEARN_RATE_BASE` | 0.004 |
| `PLASTICITY_MUL_MAX` | 3.0 |
| `MEMORY_DECAY_DEFAULT` | 0.02 |
| `REWARD_FOOD` | +1.0 / kcal単位 |
| `REWARD_DAMAGE` | -2.0 |
| `REWARD_TEMP_STRESS` | -0.3 |
| `REWARD_MATE` | +5.0 |
| `REWARD_OFFSPRING_ALIVE` | +8.0 |
| `REWARD_DECAY` | 0.95 / tick |
| `LAMARCKIAN_LAMBDA_DEFAULT` | 0.0（OFF） |

## 10. 繁殖・遺伝

**ゲノムメモリレイアウト**: 1個体 = 816 floats（3.26 KB）
`[0..119]` 形質アレル（60座 × 相同2本）／`[120..815]` 脳重み 696（単一倍体: W1=384, W2=144, W3=168）

| キー | 値 |
|---|---|
| `GENOME_TRAIT_LOCI` | 60 |
| `GENOME_LEN` | 816 |
| `MUTATION_RATE_PER_LOCUS` | 0.03 |
| `MUTATION_SIGMA` | 0.08 |
| `MUTATION_JUMP_PROB` | 0.005 |
| `MUTATION_JUMP_SIGMA` | 0.35 |
| `CROSSOVER_RATE` | 0.9 |
| `CROSSOVER_POINTS` | 2–4 |
| `WEIGHT_MUTATION_RATE` | 0.02 |
| `STRESS_MUTATION_MUL` | 2.0（個体群 < 30 で発動） |
| `INBREEDING_PENALTY_THRESHOLD` | 0.5 |
| `INBREEDING_PENALTY` | health -25 |
| `MATE_RADIUS` | 3.0 m |
| `MATE_COOLDOWN_DAYS` | 5 |
| `OFFSPRING_ENERGY_SHARE` | 0.35 / 子1匹 |
| `LITTER_MAX` | 8 |
| `MATURITY_DEFAULT_YEARS` | 1.5 |
| `MAX_AGE_DEFAULT_YEARS` | 8 |
| `JUVENILE_SIZE_MUL` | 0.4 |
| `JUVENILE_SPEED_MUL` | 0.7 |
| `SENESCENCE_START` | 0.7 × maxAge |

## 11. 種・分類

| キー | 値 |
|---|---|
| `SPECIES_SPLIT_DISTANCE` | 0.35（正規化形質距離） |
| `SPECIES_MATE_DISTANCE_LIMIT` | 0.50（これ以上離れると交配不可） |
| `PHYLO_TREE_MAX_NODES` | 5000 |
| `MIN_POP_FOR_SPECIES` | 5（下回ると「絶滅危惧」） |

## 12. 統計・保存

| キー | 値 |
|---|---|
| `STATS_RING_BUFFER_DAYS` | 5000 |
| `AUTOSAVE_INTERVAL_MIN` | 5 |
| `SAVE_SLOTS` | 10 |
| `GENOME_SCHEMA_VERSION` | 1 |

## 13. レンダリング

| キー | 値 |
|---|---|
| `LOD_FULL_DIST` | 25 m |
| `LOD_SIMPLE_DIST` | 80 m |
| `LOD_BILLBOARD_DIST` | 250 m |
| `MAX_DRAWN_AGENTS` | 6000 |
| `TERRAIN_CHUNKS` | 8 × 8 |
| `SHADOW_MAP_SIZE` | 1024 |
| `GRASS_INSTANCE_MAX` | 60000 |
| `TREE_INSTANCE_MAX` | 12000 |

## 14. 上限・安全弁

| キー | 値 | 備考 |
|---|---|---|
| `MAX_AGENTS` | 8192 | SoA 確保サイズ（816 floats/個体 = 26 MB）。20,000 超が必要なら起動時オプションで拡張 |
| `SOFT_AGENT_CAP` | 6000 | 超えると繁殖率 0.5× |
| `MIN_POP_RESCUE` | 12 | 種の個体数がこれを下回ると「保護措置」オプション（設定でON/OFF） |
| `TICK_BUDGET_MS` | 12 | 超えたらサブステップを間引く |

---

## 初期プリセット生物（スポーン用）

| プリセット | mass | diet | legLength | fur | brainSize | 備考 |
|---|---|---|---|---|---|---|
| `herbivore_starter` | 40 kg | 0.05 | 0.9 m | 0.3 | 0.25 | 4本脚、草食歯、逃走重視 |
| `carnivore_starter` | 55 kg | 0.9 | 1.0 m | 0.2 | 0.40 | 正面視、牙あり、aggression 0.7 |
| `omnivore_starter` | 25 kg | 0.5 | 0.6 m | 0.35 | 0.50 | 手先器用、好奇心高い |
| `grazer_fast` | 30 kg | 0.0 | 1.4 m | 0.1 | 0.2 | 高速特化 |
| `browser_tall` | 120 kg | 0.1 | 1.6 m | 0.25 | 0.25 | 長い首、木の葉 |
| `ambush_predator` | 70 kg | 0.95 | 0.7 m | 0.4 | 0.55 | 待ち伏せ、装甲軽め |

---

## 付録（v0.2 で追加した値）

実装で使っている値のうち、上の表にないものをここに記録する。`(仮)` は調整値で、headless で再調整の対象。

| 項目 | 値 | 出典 |
|---|---|---|
| 肉食獣プリセット `carnivore_starter` | 55 kg / 脚長 1.0 m / 毛 0.2 | parameters.md（種プリセット表） |
| 肉食獣の初期数 | 4 | (補正)：2 では初年に絶滅しやすいため。(仮) |
| 草食獣の初期数 | 80 | (補正)：40 では肉食獣の獲物が足りず、肉食獣が飢えて死ぬため。(仮) |
| 肉食獣の上限 | 300 | (仮) |
| 獲物を探す距離 / 攻撃距離 | 30 m / 1.8 m | (仮)：60 m は肉食獣が獲物を獲り尽くし、草食獣が 1〜2 匹まで崩壊 |
| 捕獲効率の半減数（避難効果） | 5 匹（視界内の獲物数 n に対し効率 n/(n+5)） | (仮)：獲物が少ないときに獲り尽くさないための Beddington–DeAngelis 型の補正 |
| 消化時間（取り扱い時間） | 2.0 日（捕食後は狩りをしない） | (仮)：Holling II。1.0 日では振動が大きかった |
| 交配相手を探す距離 | 600 m（島全体） | (補正)：個体数が少ないと 40 m では相手が見つからず、繁殖が 0 になるため |
| 極度の飢え | エネルギー比 < 0.3 では休息より狩りを優先 | (補正)：休息状態で飢死する不具合の修正 |
| 捕獲確率（接触 1 step あたり） | 0.015 × 捕食圧 × 効率 | (仮) |
| 獲物から得る食量（獲物の最大エネルギー比） | 1.0 | (仮) |
| 肉食獣の代謝倍率 | 0.5 | (仮) |
| 肉食獣の移動コスト倍率 | 0.3 | (仮)：待ち伏せ型で走り続けない前提 |
| 肉食獣の速度倍率 | 1.0 | (仮) |
| 肉食獣の繁殖間隔 | 25 日 | (仮) |
| 草食獣が捕食者を察知する距離 | 25 m | (仮) |
| 草食獣の逃走速度 | 1.25 × 最大速度 | (仮)：「逃走重視」プリセット |
| 気候スライダー範囲 | 気温 −10〜+10 ℃ / 降雨 ×0.2〜×2.5 / 季節振幅 0〜24 ℃ / 捕食圧 0〜2 | (仮) |
| 寒波 | −10 ℃ / 30 日 | (仮) |
| 熱波 | +8 ℃ / 20 日 | (仮) |
| 干ばつ | 降雨 ×0.3 / 120 日 | (仮) |
| 豪雨 | 降雨 ×2.5 / 15 日 | (仮) |
| 隕石 | 半径 80 m を全滅・草焼失、粉塵で −6 ℃ / 240 日、降雨 ×0.8 | (仮) |
| 疫病 | 草食獣 35%、肉食獣 20% が死亡 | (仮) |

### 既知の挙動（v0.3 途中の headless 結果、未解決）

- 草食獣（FSM、10 年、シード 42・43）：絶滅なし。シード 42 は 50〜139 匹で推移、シード 43 は Y3 に 6 匹まで崩壊し、その後 19〜22 匹まで回復。
- 草食獣（脳、6 年、シード 42・43）：絶滅なし。24〜95 匹で推移。FSM より少なく、飢餓と渇きによる死亡が多い。
- 肉食獣：**未安定**。FSM でもシード 42 は 10 年後に 1 匹、シード 43 は Y3 に全滅。脳モードでは毎年ほぼ全滅する。
- 原因：肉食獣と草食獣の振動（捕食量が多い年に草食獣が崩壊し、肉食獣も飢える）。視界や捕獲率を変えると、絶滅か草食獣の崩壊のどちらかになった。
- 修正済みの不具合：(1) 交配相手の探索距離 40 m で相手が見つからず、繁殖が 0 だった。(2) 休息状態が極度の飢えより優先され、飢死していた。(3) 捕食後に連続で狩りをしていた（消化時間を追加）。
- 100 年・複数シードの計測と、均衡・種分岐数（3 件以上）の受け入れ確認は未実施。
