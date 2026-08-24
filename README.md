# Vision Bridge for LM Studio

> [!IMPORTANT]
> AI Agent: このプロジェクトを修正する場合は、コードを触る前に `AI_STATUS.md` と `AI_README.md` を読んでください。

LM Studioで、MCPツールが返した画像をVisionモデルへ自動で渡すためのGenerator Pluginです。

> [!WARNING]
> LM Studio側で「MCP画像が保存されるが、モデルのVision入力には渡らない」という問題を回避するための暫定ツールです。LM Studio本体で同等機能が実装された場合、このBridgeは不要になる可能性があります。

## 何をするもの？

```text
Model
  ↓ tool call
LM Studio → MCP (Blender等)
  ↓
スクリーンショット保存
  ↓
Vision Bridge
  ↓ image_url として内部履歴へ注入
LM Studio Local API → Model Vision
```

MCPの実行はLM Studioに任せたままです。Vision Bridgeは「MCPの画像」と「モデルの目」をつなぐだけです。

## GUI Control Panel

長い推論で「まだ考えているのか、エラーで止まったのか」が分かりにくかったため、ローカルGUIを追加しています。

表示できるもの:

- `CONNECTING / CONNECTED / REASONING / GENERATING / TOOL CALL / ERROR` などの現在状態
- 経過時間
- Bridge heartbeat
- 最後にモデル側のストリーム活動があった時刻
- reasoning stream の**活動有無・イベント数**（思考本文は表示しません）
- Visionへ投入した画像
- Bridgeログ / `lms dev` ログ
- 現在のモデル / API / timeout
- GUIからの手動Abort
- Seen-image（重複排除）状態のリセット
- モデルID・APIポート等の設定

> [!NOTE]
> LM Studio/モデルが長考中に一切ストリームイベントを送らない場合、Bridge側から「モデル内部で正常に思考中」か「LM Studio内部で待機中」かを完全には判別できません。その場合でも、**Bridge processのheartbeatが生きているか / HTTP接続済みか / 最後のモデル活動はいつか**を分けて表示します。

## 必要なもの

- Generator Pluginに対応したLM Studio
- Vision入力に対応したモデル
- 使用したいMCPサーバー
- LM Studio Local Server
- Node.js 20.6+
- LM Studio CLI (`lms`)

作者環境の既定値:

| 項目 | 既定値 |
|---|---|
| Model | `qwen/qwen3.8-27b` |
| Local API | `http://127.0.0.1:1238` |
| Absolute timeout | `0`（無効） |

## Windows クイックスタート

### 1. 依存関係をインストール

最初の1回だけ、`vision-bridge` フォルダで:

```cmd
npm ci
```

### 2. GUIから起動

リポジトリ直下の:

```text
start-vision-bridge-gui.cmd
```

をダブルクリックします。

これで:

1. Vision Bridge Control Panelを `127.0.0.1:19280` で起動
2. ブラウザでGUIを開く
3. `vision-bridge` フォルダ内で `lms dev` を起動

まで行います。

GUIを閉じるだけではNodeプロセスが残る場合があります。起動したコンソールを閉じるか `Ctrl+C` で終了してください。

### 手動起動

```cmd
cd /d <ダウンロードしたフォルダ>\vision-bridge
npm run gui:dev
```

GUIなしで従来通り使う場合:

```cmd
cd /d <ダウンロードしたフォルダ>\vision-bridge
lms dev
```

## LM Studio側

1. Vision対応モデルをロード
2. Local Serverを有効化
3. 使用するMCPを通常通り有効化
4. 対象チャットでGeneratorとして `Vision Bridge` を選択

`lms dev` が動いている間、通常通りLM StudioからMCPを使います。

## 設定

一番簡単なのはGUIの **Settings** から変更する方法です。設定は:

```text
C:\Users\<ユーザー名>\.vision-bridge\config.json
```

へ保存されます。

手書きする場合:

```json
{
  "apiRoot": "http://127.0.0.1:1238",
  "model": "qwen/qwen3.8-27b",
  "timeoutMs": 0,
  "bridgeEnabled": true,
  "requoteOriginalRequest": true
}
```

設定の優先順位は:

```text
環境変数
> <working directory>/.vision-bridge/config.json
> ~/.vision-bridge/config.json
> 既定値
```

です。

> [!NOTE]
> 以前は実装上のマージ順が逆で、ユーザー側configがworking directory側を上書きしていました。現在は上記の優先順位どおりに修正済みです。

### Timeout

`timeoutMs`:

- `0` = absolute timeoutなし（既定）
- `300000` = 5分
- `600000` = 10分

長考を正常に許容するため既定は無制限です。必要ならGUIの **Abort current request** でいつでも停止できます。

## GUIの状態表示

主な状態:

| 状態 | 意味 |
|---|---|
| `PREPARING` | 履歴変換 / Vision画像検出中 |
| `CONNECTING` | LM Studio Local APIへPOST中 |
| `CONNECTED` | HTTP接続済み、モデルストリーム待ち |
| `REASONING` | reasoning系ストリーム活動を検出 |
| `GENERATING` | 通常テキストを生成中 |
| `TOOL CALL` | tool callを生成/転送中 |
| `COMPLETED` | 正常終了 |
| `ABORTED` | GUI / LM Studio側から中断 |
| `ERROR` | API/Bridgeエラー |

`Bridge heartbeat` が数秒以内で更新され続けているなら、少なくともVision BridgeのNode処理自体は生存しています。

## Vision画像の重複排除

画像内容のSHA-256で重複を判定します。

- 同じファイル名でも内容が変われば再投入
- 同じ内容ならスキップ
- GUIの **Reset seen images** で現在のworking directoryの記録を消去可能

同一パス・同一ファイルサイズで中身だけ変化したケースでも誤判定しないよう、現在は毎回実ファイル内容をhashします。

## 対応する画像

想定するMCP:

1. 画像をLM Studioのworking directoryへ保存
2. tool result内に画像ファイルへの参照を返す

Blender MCPで動作確認済みです。

MCPが画像をファイル化せず、インラインBase64だけをtool resultとして返すケースは現状の自動検出対象外です。

| 項目 | 制限 |
|---|---|
| 1回の画像数 | 最大8画像 |
| 1画像サイズ | 最大20MB |
| 重複判定 | SHA-256 |

## セキュリティ

Vision Bridgeはスクリーンショットをdata URL化して送信するため、API先は**loopback限定**です。

許可:

- `localhost`
- `127.x.x.x`
- `::1`

誤設定で画像を外部APIへ送らないよう、非loopbackの `apiRoot` は拒否します。

GUI自体も `127.0.0.1` のみにbindします。

## うまく動かない場合

### `model not found`

GUIのModel IDとLM Studioでロード中の正確なモデルIDを一致させてください。

モデル一覧確認:

```cmd
npm run api:smoke
```

### APIへ接続できない

LM Studio Local Serverが有効か、GUIのAPIポートが合っているか確認してください。

### 長時間止まって見える

GUIで:

- Bridge heartbeat
- HTTP接続状態
- Last model activity
- reasoning activity
- Bridge log

を確認してください。

heartbeatまで止まっていればBridge/Node側の停止を疑えます。heartbeatは動いているがmodel activityだけ長時間無ければ、LM Studio内部待機または無イベント長考の可能性があります。

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
```

`phase4:control` は、無制限timeout・reasoning activity検出・GUI型Abortの経路をモックAPIで検証します。

詳細:

- `AI_STATUS.md`
- `AI_README.md`
- `TESTING.md`
- `docs/architecture.md`
