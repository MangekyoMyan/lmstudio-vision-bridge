# Vision Bridge

> [!IMPORTANT]
> AI Agent: このプロジェクトを修正する場合は、コードを触る前に `AI_STATUS.md` と `AI_README.md` を読んでください。

MCPツールが返した画像をVisionモデルへ確実に渡すためのBridgeです。

現在は2つの使い方に対応しています。

1. **LM Studio Generator mode** — 従来のLM Studio Generator Pluginとして使用
2. **OpenAI-compatible Proxy mode** — Open WebUI等とOpenAI互換モデルAPIの間に挟んで使用

既存のLM Studio経路は残したまま、OpenAI互換Proxyを追加しています。

## 仕組み

### LM Studio Generator

```text
Model
  ↓ tool call
LM Studio → MCP (Blender等)
  ↓
スクリーンショット保存
  ↓
Vision Bridge Generator
  ↓ image_url として内部履歴へ注入
LM Studio Local API → Model Vision
```

MCPの実行はLM Studioが担当します。Vision BridgeはMCP tool result内の画像参照を見つけ、モデルへ渡す内部コピーにだけVision messageを追加します。

### OpenAI-compatible Proxy

```text
Open WebUI / other OpenAI client
        ↓
Vision Bridge
http://host.docker.internal:19281/v1
        ↓
OpenAI-compatible model API
例: http://127.0.0.1:8080/v1
```

`GET /v1/models` と `POST /v1/chat/completions` に対応します。ストリーミング応答はできるだけそのまま中継します。

## GUI Control Panel

Control Panelは既定で:

```text
http://127.0.0.1:19280/
```

に起動します。

表示できるもの:

- `CONNECTING / CONNECTED / REASONING / GENERATING / TOOL CALL / ERROR` などの状態
- 経過時間
- Bridge heartbeat
- Last model activity
- reasoning streamの活動有無・イベント数（思考本文は表示しません）
- Visionへ投入した画像
- Bridge / `lms dev` / OpenAI proxy のログ
- 現在のMode / Model / Upstream API / timeout
- GUIからの手動Abort
- Seen-image重複排除状態のリセット
- LM Studio / OpenAI互換Proxy両方の設定

> [!NOTE]
> モデルが内部で思考していてもAPIへreasoningイベントを出さない区間はあります。Reasoning activityが増えている場合はモデル側の活動を確実に観測できていますが、増えていないことだけでは停止とは断定できません。

## 必要なもの

共通:

- Vision入力に対応したモデル
- 使用したいMCP環境
- Node.js 20.6+

LM Studio modeのみ:

- Generator Plugin対応のLM Studio
- LM Studio CLI (`lms`)
- LM Studio Local Server

## Windows クイックスタート

### 1. 最初の1回だけ依存関係をインストール

`vision-bridge` フォルダで:

```cmd
npm ci
```

### 2. GUIを起動

リポジトリ直下の:

```text
start-vision-bridge-gui.cmd
```

をダブルクリックします。

Control Panelで **Mode** を選択します。

- `LM Studio Generator`
- `OpenAI-compatible Proxy`

設定を保存すると、そのModeに必要なプロセスへ自動で切り替わります。

- LM Studio mode → `lms dev` を起動
- OpenAI mode → OpenAI-compatible proxyを起動

GUIを閉じるだけではNodeプロセスが残る場合があります。起動したコンソールを閉じるか `Ctrl+C` で終了してください。

## LM Studio Generator mode

GUIで:

```text
Mode: LM Studio Generator
Model ID: qwen/qwen3.8-27b
LM Studio model API: http://127.0.0.1:1238
API key: lm-studio
```

など、自分の環境に合わせます。

`apiRoot` は次のどちらでも使えます。

```text
http://127.0.0.1:1238
http://127.0.0.1:1238/v1
```

LM Studio側では:

1. Vision対応モデルをロード
2. Local Serverを有効化
3. MCPを通常通り有効化
4. チャットでGeneratorとしてVision Bridgeを選択

既存のGenerator経路・MCP tool-call転送は変更していません。

## OpenAI-compatible Proxy mode

GUIで **Mode = OpenAI-compatible Proxy** を選びます。

### Upstream model API

実際にモデルを提供しているOpenAI互換APIを指定します。

例:

```text
http://127.0.0.1:8080/v1
```

または環境によって:

```text
http://host.docker.internal:8080/v1
```

`/v1`付き・なし両方に対応します。

**Model override**:

- 空欄 → Open WebUI等のクライアントが送った `model` をそのまま使用
- 値あり → 常にそのモデルIDへ置換

### Vision Bridge output API

既定値:

```text
Port: 19281
Listen: 0.0.0.0
API key: vision-bridge
```

Docker内のOpen WebUIから接続する場合:

```text
URL:     http://host.docker.internal:19281/v1
API key: vision-bridge
```

Windowsホスト上のクライアントから接続する場合:

```text
URL:     http://127.0.0.1:19281/v1
API key: vision-bridge
```

`19281` はGUIの `19280` と並べつつ、AI/開発環境でよく使われる `1234 / 3000 / 5000 / 7860 / 8000 / 8080` 等を避けるための既定値です。GUIから変更できます。

### Image working directory

OpenAI proxy経路ではLM Studio Controllerからworking directoryを取得できません。

tool resultが:

```text
fileName: scene.png
```

のような**相対パス**だけを返す場合、GUIの `Image working directory` にその画像が保存されるホスト側ディレクトリを指定してください。

絶対パスの場合は通常不要です。

## 設定ファイル

GUI設定は:

```text
C:\Users\<ユーザー名>\.vision-bridge\config.json
```

に保存されます。

主なキー:

```json
{
  "mode": "lmstudio",

  "apiRoot": "http://127.0.0.1:1238",
  "apiKey": "lm-studio",
  "model": "qwen/qwen3.8-27b",

  "openAiApiRoot": "http://127.0.0.1:8080/v1",
  "openAiApiKey": "",
  "openAiModel": "",

  "proxyHost": "0.0.0.0",
  "proxyPort": 19281,
  "proxyApiKey": "vision-bridge",
  "proxyWorkingDirectory": "",

  "timeoutMs": 0,
  "bridgeEnabled": true,
  "requoteOriginalRequest": true
}
```

LM Studio用設定とOpenAI proxy用設定は**別々に保存**されるため、Modeを切り替えても接続先を上書きしません。

設定の優先順位:

```text
環境変数
> <working directory>/.vision-bridge/config.json
> ~/.vision-bridge/config.json
> 既定値
```

## Timeout / Abort

`timeoutMs`:

- `0` = absolute timeoutなし（既定）
- `300000` = 5分
- `600000` = 10分

長考を誤って殺さないため既定は無制限です。GUIの **Abort current request** はLM Studio / OpenAI Proxy両方で使用できます。

## GUIの状態表示

| 状態 | 意味 |
|---|---|
| `PREPARING` | 履歴変換 / Vision画像検出中 |
| `CONNECTING` | Upstream model APIへ接続中 |
| `CONNECTED` | HTTP接続済み、モデルストリーム待ち |
| `REASONING` | reasoning系ストリーム活動を検出 |
| `GENERATING` | 通常テキストを生成中 |
| `TOOL CALL` | tool callを生成/中継中 |
| `COMPLETED` | 正常終了 |
| `ABORTED` | GUI / client側から中断 |
| `ERROR` | API/Bridgeエラー |

## Vision画像の重複排除

画像内容のSHA-256で判定します。

- 同じファイル名でも内容が変われば再投入
- 同じ内容ならスキップ
- GUIの **Reset seen images** からリセット可能

OpenAI Proxy modeではproxy専用のSeen stateを使い、LM Studio modeのworking-directory stateとは分けています。

## セキュリティ

### LM Studio mode

従来通り、スクリーンショット誤送信防止のためモデルAPIはloopback限定です。

- `localhost`
- `127.x.x.x`
- `::1`

### OpenAI Proxy mode

OpenAI互換APIを汎用的に扱うため、**Upstream model APIはloopback限定ではありません**。

したがって外部URLを指定すると、Vision Bridgeが挿入した画像もそのUpstreamへ送信されます。信頼できるモデルAPIだけを設定してください。

Proxy outputはDocker内Open WebUIから使えるよう既定で `0.0.0.0:19281` にlistenします。既定API keyは `vision-bridge` です。Dockerからの接続が不要ならGUIでlisten hostを `127.0.0.1` に変更できます。

GUI本体は従来通り `127.0.0.1:19280` のみです。

## うまく動かない場合

### LM Studio: model not found

GUIのModel IDとLM Studioでロード中の正確なモデルIDを合わせてください。

```cmd
npm run api:smoke
```

### Open WebUIから接続できない

まずGUIの `OpenAI proxy` が `running` になっているか確認します。

Docker版Open WebUIでは:

```text
http://host.docker.internal:19281/v1
```

を使います。`proxyHost` が `127.0.0.1` だとDockerからは接続できないため、`0.0.0.0` を選択してください。

### `/v1/models` は見えるが生成できない

GUIの `OpenAI proxy` ログとBridge logを確認してください。Upstream model API、API key、model overrideを確認します。

### 相対画像パスを見つけられない

OpenAI Proxy modeの `Image working directory` を設定してください。

## 開発・テスト

```cmd
npm run build
npm run phase2:detect
npm run phase3:bridge
npm run phase1:messages
npm run phase1:text -- --mock
npm run phase1:vision -- --mock
npm run phase1:sdkchat
npm run phase4:control
npm run phase5:proxy
```

`phase5:proxy` は:

- OpenAI Proxy起動
- output API key
- `/v1/models`
- streaming `/v1/chat/completions`
- `/v1`付きUpstream URL
- model override
- MCP tool-result画像のVision注入

をモックUpstreamで検証します。

詳細:

- `AI_STATUS.md`
- `AI_README.md`
- `TESTING.md`
- `docs/architecture.md`
