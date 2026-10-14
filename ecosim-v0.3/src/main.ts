// エントリポイント：UI（HUD）とシミュレーション Worker、3D ビューポートをつなぐ。

import { Viewer } from './render/viewer';
import { CFG } from './sim/config';
import { BIOME_NAMES, N, V } from './sim/world';
import type { Command, DayRecord, EventKind, Selected, Status, WorkerOut } from './sim/protocol';

const SEASON_NAMES = ['冬', '春', '夏', '秋'];
const DEFAULT_SEED = 42;
const MIN_POP_WARNING = CFG.MIN_POP_WARNING;

// ---------- 状態 ----------
let tool: 'observe' | 'burn' | 'spawn' | 'spawncarn' | 'event' = 'observe';
let pendingEvent: EventKind | null = null;
let selectedSlot = -1;
let status: Status | null = null;
let awaiting = false;
let days: DayRecord[] = [];
let terrainVertH: Float32Array = new Float32Array(V * V);
let terrainBiome: Uint8Array = new Uint8Array(N * N);
let grassRatio: Float32Array = new Float32Array(N * N);
let sea: number = CFG.SEA_LEVEL;
let overlayShown = false;
let lastBurnAt = 0;
let pointerDown: { x: number; y: number; moved: boolean; button: number } | null = null;
let worldSeed = DEFAULT_SEED;
let initialTraits: { mass: number; leg: number; fur: number } | null = null;

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};
const viewRoot = $('view');
const viewer = new Viewer(viewRoot);
const graph = $<HTMLCanvasElement>('graph');
const gctx = graph.getContext('2d')!;

// ---------- Worker ----------
const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });

function send(cmd: Command): void {
  worker.postMessage(cmd);
}

worker.onmessage = (e: MessageEvent<WorkerOut>) => {
  const m = e.data;
  if (m.type === 'terrain') {
    terrainVertH = m.vertH;
    terrainBiome = m.biome;
    sea = m.sea;
    grassRatio = m.grassRatio;
    viewer.setTerrain(terrainVertH, terrainBiome, sea);
    viewer.setGrass(grassRatio);
    renderWorldPanel(m.seed);
    awaiting = false;
    return;
  }
  // snapshot
  awaiting = false;
  status = m.status;
  viewer.setAgents(m.ids, m.data);
  viewer.setPredators(m.pdata, m.pstates.length);
  if (m.grassRatio) {
    grassRatio = m.grassRatio;
    viewer.setGrass(grassRatio);
  }
  if (m.days.length > 0) {
    days.push(...m.days);
    if (!initialTraits && days.length > 0) {
      const d0 = days[0]!;
      initialTraits = { mass: d0.meanMass, leg: d0.meanLeg, fur: d0.meanFur };
    }
    drawGraph();
    renderTraits();
  }
  for (const msg of m.events) appendLog(msg);
  renderTop();
  renderSelected(m.selected);
  renderStatusWidgets();
  if (status.extinct) showExtinct();
};

function sendFrame(dtMs: number): void {
  if (awaiting) return;
  awaiting = true;
  send({ type: 'frame', dtMs });
}

// ---------- 表示 ----------
function dateText(s: Status): string {
  const dayInSeason = (s.doy % CFG.DAYS_PER_SEASON) + 1;
  return `第${s.year}年 ${SEASON_NAMES[s.season]} ${dayInSeason}日`;
}

function renderTop(): void {
  if (!status) return;
  $('date').textContent = dateText(status);
  const pop = status.pop;
  $('popTop').textContent = `草食獣 ${pop} 匹${pop < MIN_POP_WARNING && pop > 0 ? '（危機）' : ''}・肉食獣 ${status.predators} 匹`;
  $('season').textContent = `${SEASON_NAMES[status.season]}（${status.doy + 1}/120日）`;
  $('yearBar').style.width = `${((status.doy + 1) / 120) * 100}%`;
  document.querySelectorAll<HTMLButtonElement>('.speed').forEach((b) => {
    const v = Number(b.dataset.speed);
    b.classList.toggle('on', status!.speed === v && !status!.extinct);
  });
}

let biomeRowsHtml = '';

function renderStatusWidgets(): void {
  if (!status) return;
  const last = days[days.length - 1];
  let grass = last ? last.grassRatio : 0;
  if (!last) {
    let sum = 0;
    for (let k = 0; k < grassRatio.length; k++) sum += grassRatio[k] ?? 0;
    grass = sum / Math.max(1, grassRatio.length);
  }
  $('world').innerHTML = `
    <span>シード</span><span>${status.seed}</span>
    <span>草の充足率（平均）</span><span>${(grass * 100).toFixed(0)}%</span>
    <span>経過</span><span>${(status.day / 120).toFixed(2)} 年</span>
    ${biomeRowsHtml}`;
}

function renderWorldPanel(seed: number): void {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < N * N; k++) counts[terrainBiome[k] ?? 0]!++;
  const total = N * N;
  biomeRowsHtml = BIOME_NAMES.map(
    (name, i) =>
      `<span><span class="swatch" style="background:${biomeColor(i)}"></span>${name}</span><span>${(((counts[i] ?? 0) / total) * 100).toFixed(0)}%</span>`,
  ).join('');
  worldSeed = seed;
  renderStatusWidgets();
}

function biomeColor(i: number): string {
  return ['#dfe9ef', '#d9c58f', '#8fbf5a', '#2f7a3a', '#1c5e3a', '#2a72b8'][i] ?? '#888';
}

function renderTraits(): void {
  const last = days[days.length - 1];
  if (!last || !initialTraits) return;
  const pct = (a: number, b: number) => `${((a / b - 1) * 100 >= 0 ? '+' : '')}${((a / b - 1) * 100).toFixed(1)}%`;
  $('traits').innerHTML = `
    <span>体重（平均）</span><span>${last.meanMass.toFixed(1)} kg（開始時比 ${pct(last.meanMass, initialTraits.mass)}）</span>
    <span>脚長（平均）</span><span>${last.meanLeg.toFixed(2)} m（開始時比 ${pct(last.meanLeg, initialTraits.leg)}）</span>
    <span>毛量（平均）</span><span>${last.meanFur.toFixed(2)}（開始時 ${initialTraits.fur.toFixed(2)}）</span>
    <span>個体数の推移</span><span>${last.pop} 匹（直近日）</span>`;
}

function renderSelected(sel: Selected | null): void {
  if (!sel) {
    if (selectedSlot >= 0) {
      selectedSlot = -1;
    }
    $('inspect').innerHTML = `<span>—</span><span>観察ツールで個体をクリック</span>`;
    return;
  }
  const ageY = (sel.age / 120).toFixed(2);
  const legRel = initialTraits ? ((sel.leg / initialTraits.leg - 1) * 100).toFixed(0) : '0';
  $('inspect').innerHTML = `
    <span>体重</span><span>${sel.mass.toFixed(1)} kg</span>
    <span>脚長</span><span>${sel.leg.toFixed(2)} m（平均比 ${Number(legRel) >= 0 ? '+' : ''}${legRel}%）</span>
    <span>毛量</span><span>${sel.fur.toFixed(2)}</span>
    <span>年齢</span><span>${ageY} 年</span>
    <span>満腹度</span><span>${(sel.energy * 100).toFixed(0)}%</span>
    <span>体力</span><span>${sel.health.toFixed(0)}</span>
    <span>水分</span><span>${sel.hydration.toFixed(0)}</span>
    <span>行動</span><span>${sel.state}</span>`;
}

function appendLog(msg: string): void {
  const log = $('log');
  const div = document.createElement('div');
  div.textContent = msg;
  log.prepend(div);
  while (log.childElementCount > 300) log.lastElementChild?.remove();
}

function drawGraph(): void {
  const W = graph.width;
  const H = graph.height;
  const g = gctx;
  g.fillStyle = '#0a1017';
  g.fillRect(0, 0, W, H);
  if (days.length < 2) return;
  const padL = 36;
  const padR = 36;
  const padT = 10;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const maxPop = Math.max(60, ...days.map((d) => Math.max(d.pop, d.predators))) * 1.1;
  const tMax = days.length - 1;
  const xOf = (i: number) => padL + (i / Math.max(1, tMax)) * iw;
  const yPop = (p: number) => padT + ih - (p / maxPop) * ih;
  const yG = (r: number) => padT + ih - Math.min(1, r) * ih;

  // 年の目盛り
  g.strokeStyle = '#1b2a38';
  g.lineWidth = 1;
  g.fillStyle = '#6c7d8d';
  g.font = '11px system-ui, sans-serif';
  const years = Math.floor(tMax / 120);
  const step = years > 40 ? 10 : years > 15 ? 5 : years > 6 ? 2 : 1;
  for (let y = 0; y <= years; y += step) {
    const x = xOf(y * 120);
    g.beginPath();
    g.moveTo(x, padT);
    g.lineTo(x, padT + ih);
    g.stroke();
    g.fillText(`${y + 1}年`, x - 8, H - 6);
  }
  // 個体数の軸（左）
  g.fillStyle = '#6c7d8d';
  for (let f = 0; f <= 1.0001; f += 0.5) {
    const p = Math.round(maxPop * f);
    g.fillText(String(p), 4, yPop(p) + 4);
  }
  // 草の軸（右）
  for (const f of [0, 0.5, 1]) {
    g.fillText(`${Math.round(f * 100)}%`, W - padR + 4, yG(f) + 4);
  }
  // 危機ライン
  g.strokeStyle = '#7a3b3b';
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(padL, yPop(MIN_POP_WARNING));
  g.lineTo(W - padR, yPop(MIN_POP_WARNING));
  g.stroke();
  g.setLineDash([]);

  const stride = Math.max(1, Math.floor(days.length / iw));
  // 草の充足率
  g.strokeStyle = '#c9a24a';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i < days.length; i += stride) {
    const x = xOf(i);
    const y = yG(days[i]!.grassRatio);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  // 個体数（草食獣・肉食獣）
  for (const [key, color] of [
    ['predators', '#c8553d'],
    ['pop', '#7fd16b'],
  ] as const) {
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < days.length; i += stride) {
      const x = xOf(i);
      const y = yPop(days[i]![key]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
}

function showExtinct(): void {
  if (overlayShown) return;
  overlayShown = true;
  const sum = { starve: 0, thirst: 0, old: 0, heat: 0, drown: 0, predated: 0, disease: 0, impact: 0 };
  for (const d of days) {
    sum.starve += d.starve;
    sum.thirst += d.thirst;
    sum.old += d.old;
    sum.heat += d.heat;
    sum.drown += d.drown;
    sum.predated += d.predated;
    sum.disease += d.disease;
    sum.impact += d.impact;
  }
  const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1;
  const row = (label: string, n: number) => `<span>${label}</span><span>${n} 件（${((n / total) * 100).toFixed(0)}%）</span>`;
  $('extinctText').textContent = `${status ? dateText(status) : ''} に草食獣が全滅しました。死亡原因の内訳：`;
  $('causes').innerHTML =
    row('餓死（食べ物不足）', sum.starve) +
    row('捕食（肉食獣）', sum.predated) +
    row('脱水', sum.thirst) +
    row('老衰', sum.old) +
    row('温度ストレス', sum.heat) +
    row('溺死', sum.drown) +
    row('疫病', sum.disease) +
    row('隕石の衝撃', sum.impact);
  $('overlay').style.display = 'flex';
}

function resetWorld(seed: number): void {
  days = [];
  initialTraits = null;
  overlayShown = false;
  selectedSlot = -1;
  $('overlay').style.display = 'none';
  $('log').innerHTML = '';
  $('traits').innerHTML = '';
  drawGraph();
  awaiting = false;
  send({ type: 'reset', seed });
}

// ---------- 操作 ----------
document.querySelectorAll<HTMLButtonElement>('.speed').forEach((b) => {
  b.addEventListener('click', () => {
    const v = Number(b.dataset.speed);
    send({ type: 'speed', value: v });
    if (status) status = { ...status, speed: v };
    renderTop();
  });
});

document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => {
  b.addEventListener('click', () => {
    tool = b.dataset.tool as typeof tool;
    pendingEvent = null;
    document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('on', x === b));
    viewRoot.style.cursor = tool === 'observe' ? 'default' : 'crosshair';
  });
});

// 気候スライダー
function bindSlider(id: string, label: (v: number) => string): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('input', () => {
    $(`${id}V`).textContent = label(Number(el.value));
    sendSettings();
  });
}
function sendSettings(): void {
  send({
    type: 'settings',
    temp: Number($<HTMLInputElement>('setTemp').value),
    rain: Number($<HTMLInputElement>('setRain').value),
    season: Number($<HTMLInputElement>('setSeason').value),
    predation: Number($<HTMLInputElement>('setPred').value),
  });
}
bindSlider('setTemp', (v) => `${v > 0 ? '+' : ''}${v}℃`);
bindSlider('setRain', (v) => `×${v.toFixed(1)}`);
bindSlider('setSeason', (v) => `${v}℃`);
bindSlider('setPred', (v) => `×${v.toFixed(1)}`);

// 災害・イベント：全体に効くものは即時、位置が要るもの（隕石・疫病）はクリックで指定
const EVENT_GLOBAL: EventKind[] = ['cold', 'heat', 'drought', 'flood'];
document.querySelectorAll<HTMLButtonElement>('.ev').forEach((b) => {
  b.addEventListener('click', () => {
    const kind = b.dataset.event as EventKind;
    if (EVENT_GLOBAL.includes(kind)) {
      send({ type: 'event', kind, x: 256, z: 256 });
      return;
    }
    tool = 'event';
    pendingEvent = kind;
    document.querySelectorAll('.tool').forEach((x) => x.classList.remove('on'));
    viewRoot.style.cursor = 'crosshair';
    appendLog(`${b.textContent?.trim()}：発生させる場所をクリックしてください`);
  });
});

const radius = $<HTMLInputElement>('radius');
radius.addEventListener('input', () => {
  $('radiusVal').textContent = `${radius.value}m`;
});

$('newWorld').addEventListener('click', () => resetWorld(Math.floor(Math.random() * 1e9)));
$('newWorld2').addEventListener('click', () => resetWorld(Math.floor(Math.random() * 1e9)));
$('retry').addEventListener('click', () => resetWorld(status ? status.seed : worldSeed));

function applyToolAt(clientX: number, clientY: number, click: boolean): void {
  if (tool === 'observe') {
    if (!click) return;
    const slot = viewer.pickAgent(clientX, clientY);
    selectedSlot = slot;
    send({ type: 'select', slot });
    if (slot < 0) renderSelected(null);
    return;
  }
  const hit = viewer.pickTerrain(clientX, clientY);
  if (!hit) return;
  if (tool === 'burn') {
    const now = performance.now();
    if (!click && now - lastBurnAt < 120) return;
    lastBurnAt = now;
    send({ type: 'burn', x: hit.x, z: hit.z, r: Number(radius.value) });
  } else if (tool === 'spawn' && click) {
    send({ type: 'spawn', x: hit.x, z: hit.z, n: 10, kind: 'herb' });
  } else if (tool === 'spawncarn' && click) {
    send({ type: 'spawn', x: hit.x, z: hit.z, n: 3, kind: 'carn' });
  } else if (tool === 'event' && click && pendingEvent) {
    send({ type: 'event', kind: pendingEvent, x: hit.x, z: hit.z });
    pendingEvent = null;
    tool = 'observe';
    document.querySelector<HTMLButtonElement>('.tool[data-tool="observe"]')?.classList.add('on');
    viewRoot.style.cursor = 'default';
  }
}

viewRoot.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pointerDown = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
  if (tool === 'burn') applyToolAt(e.clientX, e.clientY, false);
  showProbe(e.clientX, e.clientY);
});
viewRoot.addEventListener('pointermove', (e) => {
  if (!pointerDown) return;
  const dx = e.clientX - pointerDown.x;
  const dy = e.clientY - pointerDown.y;
  if (Math.hypot(dx, dy) > 5) pointerDown.moved = true;
  if (tool === 'burn' && pointerDown.moved) applyToolAt(e.clientX, e.clientY, false);
});
viewRoot.addEventListener('pointerup', (e) => {
  if (!pointerDown) return;
  const wasClick = !pointerDown.moved;
  pointerDown = null;
  if (wasClick) applyToolAt(e.clientX, e.clientY, true);
});

function showProbe(clientX: number, clientY: number): void {
  const hit = viewer.pickTerrain(clientX, clientY);
  if (!hit) return;
  const i = Math.min(N - 1, Math.max(0, Math.floor(hit.x / CFG.CELL_M)));
  const j = Math.min(N - 1, Math.max(0, Math.floor(hit.z / CFG.CELL_M)));
  const k = j * N + i;
  const b = terrainBiome[k] ?? 0;
  const h = hit.h;
  const water = h < sea;
  $('probe').innerHTML = `
    <span>バイオーム</span><span>${BIOME_NAMES[b] ?? ''}</span>
    <span>標高</span><span>${h.toFixed(1)} m${water ? '（水中）' : ''}</span>
    <span>草の充足率</span><span>${water ? '—' : `${(((grassRatio[k] ?? 0) * 100)).toFixed(0)}%`}</span>
    <span>水までの距離</span><span>${water ? '0' : '（BFS）'}</span>`;
}

// ---------- 3D と時間 ----------

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  const dtMs = now - last;
  last = now;
  viewer.frame(dt);
  sendFrame(dtMs);
  requestAnimationFrame(loop);
}

send({ type: 'init', seed: DEFAULT_SEED });
requestAnimationFrame(loop);
renderStatusWidgets();
drawGraph();
