# 05. GitHub Pages で公開する手順（やさしい版）

ブラウザだけでできます。コードの知識は要りません。

## 全体の流れ

1. GitHub で **Pages をオンにする**（最初の 1 回だけ）
2. 私が出した **PR（変更のお知らせ）を「マージ」する**
3. 数分待つと、URL でページが開ける
4. PC の Chrome と Pixel で開いて、数字を教えてもらう

> **順番が大事**: 先に 1（Pages をオン）、その後に 2（マージ）。逆でも動きますが、その場合は 3 で一度「手動で実行」が要ります（下の「うまくいかないとき」）。

## 1. Pages をオンにする

1. https://github.com/kemu6438-prog/-/settings/pages を開く
2. **Build and deployment** の **Source** を **GitHub Actions** にする（プルダウンで選ぶだけ。保存ボタンは無く、選んだら反映されます）

## 2. PR をマージする

1. https://github.com/kemu6438-prog/-/pulls を開く
2. 一番上の PR（題名: 「性能チェックページと自動公開の設定を追加」）を開く
3. 緑の **Merge pull request** → **Confirm merge** を押す

## 3. 公開 URL

数分後、次の URL で開けます。

**https://kemu6438-prog.github.io/-/**

進み具合は https://github.com/kemu6438-prog/-/actions で見られます（黄色の丸＝作業中、緑のチェック＝完了、赤い×＝失敗）。

## 4. 測ってもらいたいこと

ページ左上に数字が出ます。

- **大きい数字** … 1 秒に何コマ描けているか（コマ数）
- **（最長 〇〇 ms）** … いちばん長く止まった 1 コマの時間（小さいほど滑らか）
- **描画方式** … WebGPU か WebGL 2
- **GPU** … 画面を描いている部品の名前

**「軽い」「ふつう」「重い」** の 3 つのボタンを順に押して、それぞれ数字が落ち着くまで 10 秒ほど待ち、**スクリーンショットをチャットに貼ってください。** PC と Pixel の両方でお願いします（Pixel は後でも大丈夫です）。

## うまくいかないとき

| 症状 | 対処 |
| --- | --- |
| Actions が赤い × になった | その画面をスクリーンショットで教えてください |
| マージしたのに URL が 404 | https://github.com/kemu6438-prog/-/actions → 左の **Deploy to GitHub Pages** → 右の **Run workflow** を押す。それでもだめならスクショをください |
| リポジトリ名が `-` なので Pages の URL がうまく動かない | その場合は、Settings → General → **Repository name** を `machi-drive-view` などに変更します（URL が変わります。私も合わせて直します） |
| 画面が真っ黒 | 使っているブラウザの名前とバージョンを教えてください（Chrome 最新版推奨） |
