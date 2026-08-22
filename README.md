# Vision Bridge for LM Studio

> [!IMPORTANT]
> AI Agent
> このプロジェクトを修正する場合は、コードを触る前に `STATUS.md` と `AI_README.md` を読んでください。

LM Studioで、MCPツールが返した画像をVisionモデルへ自動で渡すためのGenerator Pluginです。

> [!WARNING]
> このツールは、LM Studioで
>
> 「MCPから返された画像は保存されるが、Visionモデルの画像入力には渡されない」
>
> という問題を回避するために作った暫定的なものです。
>
> LM Studio本体でこの問題が修正された場合、このPluginは不要になる可能性があります。

## 何ができる？

たとえばBlender MCPでスクリーンショットを取得した場合、次の流れを自動化できます。

Qwen
↓
Blender MCP
↓
スクリーンショット生成
↓
Vision Bridge
↓
QwenのVision入力
↓
画像を見て判断

これにより、

画面を見る
↓
MCPで操作する
↓
もう一度画面を見る
↓
修正する

といったループを、画像を手動で貼り付けずに行えます。

> [!NOTE]
> Vision Bridge自身がMCPを実行するわけではありません。
>
> MCPの実行はこれまで通りLM Studioに任せ、Vision BridgeはMCPが返した画像とモデルのVision入力をつなぐだけです。

## 必要なもの

* Generator Pluginに対応したLM Studio
* Vision入力に対応したモデル
* 使用したいMCPサーバー
* LM StudioのLocal API

### 作者環境

| 項目        | 使用環境             |
| --------- | ---------------- |
| Model     | `Qwen3.8-27B`    |
| MCP       | Blender MCP      |
| Local API | `127.0.0.1:1238` |

> [!NOTE]
> 作者環境ではLM Studio Local APIのポートをデフォルトから変更しています。
>
> 別ポートを使用している場合は設定を変更してください。

別のVisionモデルや別ポートでも使用できます。

## インストール

### 1. 依存関係をインストールする

GitHubからcloneした場合など、`node_modules` が存在しない場合は `vision-bridge` フォルダで実行します。

```bash
npm ci
```

### 2. LM Studio側を準備する

1. Vision対応モデルをロードする
2. Local Serverを有効化する
3. 使用するMCPを通常通り設定する

### 3. Vision Bridgeを登録する

LM Studioの Plugins から `vision-bridge` フォルダをPluginとして追加します。

その後、対象モデルのGeneratorとして `Vision Bridge` を選択してください。

## モデルとAPIの設定

作者環境の既定値は以下です。

| 設定    | 既定値                     |
| ----- | ----------------------- |
| Model | `qwen/qwen3.8-27b`      |
| API   | `http://127.0.0.1:1238` |

環境が異なる場合は変更してください。

### Windows

以下のファイルを作成します。

`C:\Users\<ユーザー名>\.vision-bridge\config.json`

内容：

```json
{
  "apiRoot": "http://127.0.0.1:1234",
  "model": "使用するモデルID"
}
```

`1234` の部分は、自分のLM Studio Local Serverのポートに合わせてください。

これで動かない場合があります。原因は複雑なので修正はしません。
その場合は直接
MCP_qwen3.8\vision-bridge\src\config.ts

この中の89行目にあります。

model: getStr("model", "VISION_BRIDGE_MODEL", "qwen/qwen3.8-27b"),

これを、

model: getStr("model", "VISION_BRIDGE_MODEL", "Gemma 4 31Bの正確なモデルID"),

に変更してください。

たとえばLM Studio上のIDが仮に google/gemma-4-31b なら、

model: getStr("model", "VISION_BRIDGE_MODEL", "google/gemma-4-31b"),

です。モデルIDは推測せず、LM Studioに表示されている正確なIDを使ってください。

ポートはその1個上の

apiRoot: getStr("apiRoot", "VISION_BRIDGE_API_ROOT", "http://127.0.0.1:1238")

です

#### モデルIDが分からない場合

リポジトリのルートで以下を実行します。

```bash
npm run api:smoke
```

LM Studio APIから認識されているモデルを確認できます。

### macOS / Linux

以下に同じ内容の設定ファイルを作成してください。

`~/.vision-bridge/config.json`

> [!WARNING]
> macOS / Linuxでの動作保証はありません。作者環境ではテストしていません。

## 使い方
まずはコマンドプロンプトで起動します。
```cd /d <ダウンロードしたフォルダ>\vision-bridge```

そのあとに

```lms dev```

設定が終われば、普段通りLM StudioからMCPを使うだけです。

コマンドプロンプトは消しちゃダメです。

たとえばBlender MCPなら、次のように指示できます。

> 現在のBlender画面をスクリーンショットで確認してください。
> 問題があれば修正し、修正後にもう一度スクリーンショットを取得して確認してください。

処理は次のように進みます。

MCP
↓
画像取得
↓
Vision入力
↓
判断
↓
MCP

画像を手動でLM Studioへ添付する必要はありません。

## 対応する画像

Vision Bridgeは、MCPツールが次の形式で画像を扱う場合を対象にしています。

1. 画像をLM Studioのworking directoryへ保存する
2. tool result内にその画像への参照を返す

Blender MCPでは動作確認済みです。

> [!NOTE]
> MCPが画像をファイルとして保存せず、インラインBase64だけを返す場合などは対象外です。

## 制限

| 項目      | 制限         |
| ------- | ---------- |
| 1回の画像数  | 最大8画像      |
| 1画像のサイズ | 最大20MB     |
| 重複判定    | SHA-256    |
| 同名ファイル  | 内容が変われば再投入 |

同じ内容の画像はSHA-256で判定し、重複投入を防止します。

ファイル名が同じでも画像内容が変化していれば、新しい画像として投入されます。

## うまく動かない場合

### `model not found`

設定した `model` と、LM StudioでロードしているモデルIDが一致しているか確認してください。

### APIへ接続できない

LM StudioのLocal Serverが有効になっているか確認してください。

また、`apiRoot` のポートが自分の環境と一致しているか確認してください。

例：

```json
{
  "apiRoot": "http://127.0.0.1:1234"
}
```

### Pluginを登録できない

Generator Pluginに対応したLM Studioが必要です。

古いLM StudioではPlugin API自体が存在しないため動作しません。

### MCPは動くが画像が見えていない

working directory内の `.vision-bridge.log` を確認してください。

主に次の情報が記録されます。

* 画像の検出
* Visionへの投入
* 重複画像のスキップ
* APIエラー

## 詳細・開発資料

このプロジェクトはローカルLLMを使いながら開発したため、内部にはAI向けの引き継ぎ資料も残っています。

### `AI_README.md`

開発時の詳細READMEです。

内部構造やAI向け指示を含みます。

### `AI_STATUS.md`

実装状況、ファイル構成、不変条件などを記載しています。

> [!WARNING]
> 古いデータのため、すでに修正済みのバグも記載されています。

### `TESTING.md`

テスト方法とトラブルシューティングを記載しています。

### `docs/architecture.md`

Vision Bridgeの内部設計を記載しています。

## 注意

Vision BridgeはLM Studio本体の問題を迂回するために作った暫定的なBridgeです。

LM Studioのアップデートによって、Plugin APIやMCP画像処理の仕様が変わった場合は動作しなくなる可能性があります。
