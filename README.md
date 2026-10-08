# 街ドライブビュー（仮称）

車が街中を走る様子を、**リアルタイムにシミュレーションして、リアルタイムの 3D 映像として眺める**ブラウザゲーム。

参考: [kexi/tokyo-od-game](https://github.com/kexi/tokyo-od-game)（東京 23 区を PLATEAU 3D 都市モデルで走る three.js ゲーム）

> 現在は **仕様策定フェーズ + 性能チェックページ**（街はまだ出ません）。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/01-research.md](docs/01-research.md) | 技術調査（参考実装の分析、データソース、WebGPU/three.js、シミュレーション、ライセンス） |
| [docs/02-spec.md](docs/02-spec.md) | 仕様書（ゴール、機能/非機能要件、受入基準、法務、リスク、**未決事項**） |
| [docs/03-architecture.md](docs/03-architecture.md) | アーキテクチャ設計と技術選定（ADR） |
| [docs/04-roadmap.md](docs/04-roadmap.md) | マイルストーン（M0 技術検証 → M3 初期リリース → M5 手動運転） |

| [docs/06-measurements.md](docs/06-measurements.md) | 性能チェックの結果（PC・Pixel 9a） |
| [docs/07-building-check-page.md](docs/07-building-check-page.md) | 建物データ確認ページの見方と確認項目 |
| [docs/05-github-pages-guide.md](docs/05-github-pages-guide.md) | GitHub Pages で公開する手順（やさしい版） |

まず [docs/02-spec.md](docs/02-spec.md) の「10. 未決事項」を読んで答えてください。

## 開発（動かし方）

```sh
npm install
npm run dev      # 開発用サーバ
npm run build    # 公開用ファイルを dist/ に作る
```

`main` に変更が入ると、GitHub Actions が GitHub Pages に自動で公開します。


## 出典・素材

- 3D都市モデル Project PLATEAU（国土交通省）／道路: 国土地理院ベクトルタイル
- 質感の素材: Poly Haven（https://polyhaven.com ・CC0）。実行時に読み込む。
