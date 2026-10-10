// 「引っかかり」の犯人探し。自分の処理（更新・描画命令）に入っていない時間が、どこで失われているかを調べる。
//  ・ブラウザの「長い処理」の通知（longtask / long-animation-frame）を受け取り、描画コマの中か外かを分ける
//  ・外なら、読み込んだデータの解析など「描画以外の処理」が止めている。無ければ GPU（グラフィック）待ち
// 画面の描画には一切さわらない（見るだけ）。

type Span = { s: number; e: number };

/** 長い処理 [s, e] が、描画コマの区間のどれと重なるか（0〜1）。区間は古い順 */
export function overlapRatio(spans: Span[], s: number, e: number): number {
  const d = e - s;
  if (d <= 0) return 0;
  let ov = 0;
  for (const sp of spans) {
    if (sp.e <= s || sp.s >= e) continue;
    ov += Math.min(e, sp.e) - Math.max(s, sp.s);
  }
  return Math.min(1, ov / d);
}

type Script = { duration: number; invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string };

export class StallMeter {
  private spans: Span[] = [];
  private frames = 0;
  private total = 0;
  private body = 0;
  private worst = 0;
  private hitches = 0;
  private outsideMs = 0;
  private outsideN = 0;
  private insideN = 0;
  private winStart = performance.now();
  private logged = 0;
  supported = false;
  /** 走行中だけ、長い処理を 1 件ずつ記録する（起動直後の読み込みでログが埋まらないように） */
  active = false;

  constructor(private readonly log: (m: string) => void) {
    try {
      const types = PerformanceObserver.supportedEntryTypes ?? [];
      const hasLoaf = types.includes("long-animation-frame");
      if (types.includes("longtask")) {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) this.onLong(e.startTime, e.duration, null); }).observe({ type: "longtask", buffered: false });
        this.supported = true;
      }
      if (hasLoaf) {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const scripts = ((e as unknown as { scripts?: Script[] }).scripts ?? []).slice().sort((a, b) => b.duration - a.duration);
            if (this.active && scripts.length && e.duration >= 70 && this.logged < 30) {
              const top = scripts.slice(0, 2).map((x) => `${x.invokerType ?? "?"}:${x.sourceFunctionName || x.invoker || "?"}@${(x.sourceURL ?? "").split("/").pop()} ${x.duration.toFixed(0)}ms`).join(" / ");
              this.logged++;
              this.log(`  └ 長いコマの中身（ブラウザの記録）: ${top}`);
            }
          }
        }).observe({ type: "long-animation-frame", buffered: false });
      }
    } catch { /* 未対応のブラウザでは、何もしない */ }
  }

  /** 毎コマの最後に呼ぶ。start = このコマの先頭の時刻、gap = 前のコマの先頭からの間隔 */
  frame(start: number, end: number, gap: number) {
    this.spans.push({ s: start, e: end });
    if (this.spans.length > 240) this.spans.splice(0, this.spans.length - 240);
    this.frames++;
    this.total += gap;
    this.body += end - start;
    this.worst = Math.max(this.worst, gap);
    if (gap > 70) this.hitches++;
  }

  private onLong(s: number, d: number, _x: null) {
    const inside = overlapRatio(this.spans, s, s + d) > 0.6;
    if (inside) this.insideN++; else { this.outsideN++; this.outsideMs += d; }
    if (this.active && this.logged < 30 && !document.hidden) {
      this.logged++;
      this.log(`長い処理 ${d.toFixed(0)} ms: ${inside ? "描画コマの中（更新・描画命令）" : "描画コマの外（データの解析・読み込みなど）"}`);
    }
  }

  /** 10 秒ぶんの集計を文字にして返し、数え直す。短すぎるときは null */
  summary(extra: string): string | null {
    const now = performance.now();
    const el = now - this.winStart;
    if (el < 9500 || this.frames < 20) return null;
    const fps = (this.frames * 1000) / this.total;
    const wait = Math.max(0, this.total - this.body - this.outsideMs);
    const s = `走行 ${(el / 1000).toFixed(0)} 秒の集計: ${fps.toFixed(0)} コマ/秒 / 最悪 ${this.worst.toFixed(0)} ms / 70 ms 超 ${this.hitches} 回`
      + ` ｜ 時間の使い道（1 秒あたり）: 自分の処理 ${((this.body / el) * 1000).toFixed(0)} ms・描画の外の長い処理 ${((this.outsideMs / el) * 1000).toFixed(0)} ms（${this.outsideN} 回）`
      + `・その他と GPU 待ち ${((wait / el) * 1000).toFixed(0)} ms ${extra}`;
    this.frames = 0; this.total = 0; this.body = 0; this.worst = 0; this.hitches = 0; this.outsideMs = 0; this.outsideN = 0; this.insideN = 0;
    this.winStart = now;
    return s;
  }

  reset() { this.winStart = performance.now(); this.frames = 0; this.total = 0; this.body = 0; this.worst = 0; this.hitches = 0; this.outsideMs = 0; this.outsideN = 0; this.insideN = 0; }
}
