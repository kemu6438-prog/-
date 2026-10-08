// PLATEAU（国交省の3D都市モデル）の建物データの場所を、配信カタログから調べる。
// URL は変わることがあるので、決め打ちせずに毎回カタログに聞く。失敗したら候補の URL を順に試す。
export const CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets";

type Dataset = {
  name: string;
  city_code?: string;
  ward_code?: string;
  type_en?: string;
  lod?: string;
  url?: string;
  year?: number;
  texture?: boolean;
  format?: string;
};

export type TilesetChoice = { label: string; url: string };

/** 名古屋市の建物 LOD1 の候補を、カタログから探す。区ごとに分かれていれば全部返す。 */
export async function findBuildingTilesets(
  codePrefixes: string[],
  lod: 1 | 2,
  log: (m: string) => void,
): Promise<TilesetChoice[]> {
  const matches = (code?: string) => !!code && codePrefixes.some((p) => code.startsWith(p));
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`カタログ HTTP ${res.status}`);
    const json = (await res.json()) as { datasets?: Dataset[] };
    const all = json.datasets ?? [];
    log(`カタログ: ${all.length} 件`);
    const mine = all.filter(
      (d) =>
        d.type_en === "bldg" &&
        d.format !== "MVT" &&
        (matches(d.ward_code) || matches(d.city_code)),
    );
    log(`建物データ候補: ${mine.length} 件（${mine.map((d) => `LOD${d.lod}${d.texture ? "+tex" : ""}/${d.year}`).join(", ")}）`);
    // 指定の LOD を、区ごとに最新年度（LOD2 は写真つきを優先）で 1 つ選ぶ。
    let want = mine.filter((d) => String(d.lod) === String(lod) && d.url);
    // 区ごとのデータがあるなら、市全体のデータは使わない（二重に読まない）
    if (want.some((d) => d.ward_code)) want = want.filter((d) => d.ward_code);
    const byWard = new Map<string, Dataset>();
    const score = (d: Dataset) => (d.year ?? 0) * 10 + (lod === 2 && d.texture ? 5 : 0);
    for (const d of want) {
      const key = d.ward_code ?? d.city_code ?? "";
      const prev = byWard.get(key);
      if (!prev || score(d) > score(prev)) byWard.set(key, d);
    }
    const picked = [...byWard.values()].map((d) => ({ label: `${d.name}(${d.year})`, url: d.url! }));
    if (picked.length > 0) return picked;
    log(`カタログに LOD${lod} が見つからない → 決め打ち候補を使う`);
  } catch (e) {
    log(`カタログ取得に失敗: ${(e as Error).message} → 決め打ち候補を使う`);
  }
  return codePrefixes
    .filter((p) => p.length === 5)
    .map((p) => ({
      label: `${p}-bldg-lod${lod}-latest（決め打ち）`,
      url: `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${p}-bldg-lod${lod}-latest/tileset.json`,
    }));
}
