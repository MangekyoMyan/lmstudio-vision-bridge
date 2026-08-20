# LM Studio × Qwen3.8-27B : MCP画像 → Vision入力「Vision Bridge」

> 📌 **まず [STATUS.md](STATUS.md) を読むこと** — 現在の進捗・ファイルマップ（各ファイルの职责）・
> 不変条件・バグ修正履歴が詰まっている。コードを全部読み直す必要はない。
>
> ⚠️ **別の環境で使う／第三者に渡す場合は、必ず
> [「モデル名・API先を変える場所（別環境で使うときに必要）」](#モデル名api先を変える場所別環境で使うときに必要) を先に読むこと。**
> 既定値は作者の環境（モデル `qwen/qwen3.8-27b`・サーバー `127.0.0.1:1238`）に固定されているため、
> そのままでは相手の環境で折返しが失敗する。

## 目的と仕組み

LM Studioでは、MCPツール(Blender MCPなど)が返した画像が **working directoryへファイルとして保存される** 一方で、
その画像がVisionモデル(Qwen3.8-27B)の画像入力として渡されません。

本プロジェクトは **LM StudioのGenerator Plugin** を用いて、この欠落だけをつなぐ「Vision Bridge」を実装します。

- MCPクライアントの再実装は **しない**
- MCP実行は **既存のLM Studio機能にすべて任せる**
- Generatorは「モデル推論のラッパー」として、次のことをだけやる

1. LM Studio Chatの会話履歴を **ローカルOpenAI互換API(既定 `127.0.0.1:1238`)** へ転送し、ロード済みのモデルで推論させる(折り返し構造)
2. モデルがtool callを生成した場合は **GeneratorController経由でLM Studioへ報告** する(実行自体はしない)
3. 更新済み履歴を再度受け取ったとき、**直前のtool resultが参照している画像** をworking directoryから特定する
4. 特定できた場合 **だけ**、モデルへ送る履歴の**コピー**に「画像付きのsynthetic user message」を挿入してVision入力とする
   (LM Studio UI上の永続履歴には一切書き込まない)
5. 同一画像の **重複投入を防ぐ**(画像内容のSHA-256)

```
┌──────────────────────── LM Studio (単一インスタンス) ────────────────────────┐
│                                                                              │
│  Chat UI (Qwen3.8-27B + Blender MCP)                                         │
│     │ 1. user prompt                                                         │
│     ▼                                                                        │
│  Generator (本プラグイン: Vision Bridge)                                       │
│     │ 2. 履歴 + tool definitions ── HTTP (127.0.0.1:1238) ──┐                │
│     │                                                       ▼                │
│     │                                        /v1/chat/completions            │
│     │                                                       │                │
│     │                                        3. Qwen3.8-27B (ロード済み)     │
│     │ 4. トークン / tool call ◄───────────────┘                │                │
│     │ 5. tool call → ctl.report_tool_call(...)                │                │
│     ▼                                                        │                │
│  LM Studio がMCP(Blender)を実行 ── 画像保存 ──► working directory            │
│  6. generate(更新済み履歴) ← Generatorへ再呼出                  │                │
│  7. Vision Bridge: tool resultの画像参照 → working dirの画像へ対応付け       │
│     → synthetic user message(画像data URL)を内部コピーに挿入                 │
│     → 再送(8へ)                                                            │
│  8. Qwenが画像を見て応答 / 追加tool call → 5.へループ                │
└──────────────────────────────────────────────────────────────────────────────┘
```

## ディレクトリ構成

```
MCP_qwen3.8/
├── README.md                  ← 本書
├── STATUS.md                  ← 進捗・ファイルマップ・不変条件
├── TESTING.md                 ← Phase別のテスト手順・診断表
├── package.json               ← 便利スクリプト集(npm run phase1:text 等)
├── docs/
│   └── architecture.md        ← 設計判断・アダプタの位置
├── vision-bridge/             ← ★LM StudioにインストールするGenerator Plugin本体
│   ├── manifest.json          ← プラグインマニフェスト(type: plugin / runner: node)
│   ├── package.json           ← @lmstudio/sdk 1.4.0 依存 / build・devスクリプト
│   ├── package-lock.json      ← npm install の再現性用
│   ├── tsconfig.json          ← rootDir "." / outDir "build"
│   ├── index.ts               ← 旧beta API向けのレガシーエントリ + named exports(ハーネス用)
│   ├── src/                   ← ★TypeScriptソース(編集・拡張用)
│   │   ├── index.ts           ← ★公式エントリ: main(context) → context.withGenerator(generate)
│   │   │                        (現行host API: fragmentGenerated / toolCallGeneration* / SDK Chatアダプタ)
│   │   ├── generator.ts       ← 旧beta APIのVisionBridgeGenerator(ハーネストest用)
│   │   └── (config / dedup / image-detect / log / messages /
│   │        openai-client / types / vision-bridge / controller)
│   ├── build/                 ← tsc出力(build/index.js + build/src/*.js)
│   │                            ★ハーネストestの実行対象＝src/と同期が必要
│   ├── .lmstudio/
│   │   ├── entry.ts           ← hostブートストラップ(lms devが生成)。../src/index.tsを読みmain()を呼ぶ
│   │   └── dev.js             ← lms dev 用のバンドル
│   ├── types/lmstudio.d.ts    ← 旧beta SDKのambient型(参考)
│   └── node_modules/          ← 導入済み(typescript / @lmstudio/sdk 1.4.0 等)
├── scripts/harness/           ← LM Studio外部でのテストハーネス(mock controller + mock API)
└── proxy/                     ← フォールバック用「薄いLLMプロキシ」(必要時のみ)
```

## セットアップ

### 必要なもの

- **LM Studio: プラグイン機能(Generator Plugin)が使えるバージョン**
  — 本プラグインは現行プラグインホストAPI(`withGenerator`、SDK `1.4.0`)を使うため、
  プラグイン機能のない古いバージョンでは登録しても生成できない
- Vision対応モデル(作者環境では Qwen3.8-27B)をロード済み
- ローカルサーバーを有効化(ポートは任意・既定値は下記「モデル名・API先を変える場所」参照)
- MCP(Blender MCP等)は従来どおり設定。本プラグインはMCPには一切触れない
- **Node.js 20.6+** は **テストハーネス実行時のみ必要**(通常のプラグイン使用には不要。
  プラグイン自体はLM Studioのプラグインホスト内で動く)

### プラグイン登録・選択

1. LM Studio の **Plugins(プラグイン)** 画面から `vision-bridge` フォルダをプラグインとして追加
   - 読み込まれるエントリは `src/index.ts` の `main(context)`
     (hostブートストラップ `.lmstudio/entry.ts` 経由。`manifest.json` の `type: plugin` により識別)
2. 対象モデル(例: Qwen3.8-27B)のpredictionで **Generatorとして本プラグインを選択**

## モデル名・API先を変える場所（別環境で使うときに必要）

> **ここが最も重要な運用手順です。**
> 作者環境向けにコード既定値が固定されているため、**モデル名とAPI先(ポート)の2つ**を
> 自分の環境に合わせないと、折返しリクエストが失敗します。

### 既定値（`vision-bridge/src/config.ts`）

| 項目 | 既定値 | 意味 |
|---|---|---|
| `apiRoot` | `http://127.0.0.1:1238` | 折返し先(折り返し先)のLM Studioローカルサーバー。作者は1238番で運用。LM Studioの通常既定は**1234**なので、1234のままの方は要設定 |
| `model` | `qwen/qwen3.8-27b` | 折返しリクエストに載せるモデルID。作者がロードしているモデル名。**「auto」ではない** — 相手のロード済みモデルIDと一致しないとAPIが「model not found」等で拒否する可能性が高い |
| `apiKey` | `lm-studio` | Bearer認証キー(LM Studioローカルサーバーの既定キー)。変更していなければそのまま可 |

### 変更方法（推奨順）

**A. 設定ファイル（推奨・永続的）— コードを一切触らない**

設定の優先度は **環境変数 > working directory設定 > ホーム設定 > コード既定** です。
2つのどちらかの場所に `config.json` を作ります。

1. **`<working directory>/.vision-bridge/config.json`**（そのチャット/予測ごとに効く、最優先）
   - 「working directory」はLM Studioが各predictionに割り当てる作業ディレクトリ。
     値の特定法: ログ `<working directory>/.vision-bridge.log` の
     `generate() invoked by LM Studio ... workingDirectory: <ここ>` の行を見る
     (このログ自体もその配下に出る)
2. **`~/.vision-bridge/config.json`**（そのユーザーの全チャットに効く。グローバル既定値として使うならここ）
   - Windows: `C:\Users\<あなた>\.vision-bridge\config.json`
   - macOS/Linux: `~/.vision-bridge/config.json`

内容例（自分の環境に合わせる2行）:

```json
{
  "apiRoot": "http://127.0.0.1:1234",
  "model": "qwen2.5-vl-72b-instruct"
}
```

- `apiRoot` = 自分が有効化しているLM StudioローカルサーバーのURL（LM Studioのサーバー設定画面のポート）
- `model` = 自分がロードしているモデルのID
  - 特定法: `npm run api:smoke`（下記）の出力 `models: <ID>, ...` に載っているIDをそのまま使う
  - または `lms ls` / LM Studioのモデル一覧の名称

**B. 環境変数（ハーネス実行時や、LM Studioプロセスを起動するシェルで）**

| 環境変数 | 対応キー |
|---|---|
| `VISION_BRIDGE_API_ROOT` | `apiRoot` |
| `VISION_BRIDGE_MODEL` | `model` |
| `VISION_BRIDGE_API_KEY` | `apiKey` |

例（PowerShell）:

```powershell
$env:VISION_BRIDGE_API_ROOT = "http://127.0.0.1:1234"
$env:VISION_BRIDGE_MODEL    = "qwen2.5-vl-72b-instruct"
```

> 注意: LM Studioアプリ内部で動くプラグインは、アプリを起動したときの環境を継承します。
> **アプリ起動前に**環境変数を決めないと効かないため、**永続設定はA(設定ファイル)を推奨**します。

**C. コード既定値の変更（最終手段）**

本当に既定値自体を変えたい場合のみ `vision-bridge/src/config.ts` の `loadConfig()` 内の
`apiRoot` / `model` / `apiKey` の既定値を書き換えます。
その場合はハーネス用ミラーも再ビルドしてください（`npm run build`、ルートから実行可能）。

### 変更後の確認

```bash
npm run api:smoke          # サーバー疎通 + ロード済みモデルIDの確認
npm run phase1:text -- --mock   # パイプラインの疎通確認(モデル不要)
```

その後、UIで1往復（「BRIDGE-OK とだけ答えて」程度）が返れば折返しは成立しています。

## 設定(優先順: 環境変数 > `.vision-bridge/config.json`)

| 設定キー / 環境変数 | 既定値 | 説明 |
|---|---|---|
| `apiRoot` / `VISION_BRIDGE_API_ROOT` | `http://127.0.0.1:1238` | 折返し先APIのルート |
| `apiKey` / `VISION_BRIDGE_API_KEY` | `lm-studio` | Bearer認証 |
| `model` / `VISION_BRIDGE_MODEL` | `qwen/qwen3.8-27b` | 推論モデルID(既定値は作者環境用。別環境では要変更) |
| `timeoutMs` / `VISION_BRIDGE_TIMEOUT_MS` | `300000` | 1リクエストのタイムアウト |
| `maxImageBytes` / `VISION_BRIDGE_MAX_IMAGE_BYTES` | `20971520` (20MB) | これより大きい画像はVision投入しない(エラーログ) |
| `logLevel` / `VISION_BRIDGE_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `logFile` / `VISION_BRIDGE_LOG_FILE` | `<working directory>/.vision-bridge.log` | ログ先 |
| `bridgeEnabled` / `VISION_BRIDGE_ENABLED` | `true` | `false`でPhase2/3だけ無効化(Phase1の折り返しは維持) |
| `syntheticText` / `VISION_BRIDGE_SYNTHETIC_TEXT` | 注記テキスト | 挿入するsynthetic messageのテキスト |
| `requoteOriginalRequest` / `VISION_BRIDGE_REQUOTE_ORIGINAL_REQUEST` | `true` | `true`なら直前のuserリクエストをsynthetic messageに逐語引用して注入(モデル挙動が堅くなる想定)。`false`で `syntheticText` のみ |

設定ファイル例(`<working directory>/.vision-bridge/config.json`):
```json
{ "apiRoot": "http://127.0.0.1:18080", "logLevel": "debug" }
```

## ログ

- `<working directory>/.vision-bridge.log`(追加モード)+ コンソール
- 必ず出す内容: Generator invocation / working directory / API接続成功・失敗 /
  tool call発生・報告 / tool result受信 / 画像候補検出 / 採用画像 /
  Vision投入 / **重複スキップ** / API・画像読み込みエラー
- 巨大Base64は **ログに出さない**(長さだけ表示)

## テスト

詳細は **TESTING.md**。短くすると:

```bash
# 前提: src/*.ts を編集した直後は必ず build/ ミラーを再生成する
#       (ハーネストestは vision-bridge/build/ を実行対象にするため)
npm run build

# Phase 0: API疎通確認(実機。ロード済みモデルIDが載る)
npm run api:smoke

# Phase 1: 折り返し推論(テキスト) + Vision入力
npm run phase1:text -- --mock      # モックAPIでパイプライン検証(モデル不要・推奨)
npm run phase1:vision -- --mock    # Visionデータパス(モックがdata URLを「見た」か)

# Phase 1d: 公式エントリ(src/index.ts::generate) + SDK Chat形状・現行host API
npm run phase1:sdkchat             # 空Chatガード/新API tool call報告/空content正規化 等
npm run phase1:messages            # 変換・型正規化(純粋ロジック・API不要)

# Phase 1.5: 【最重要】LM Studio UI内でチャットし、折り返しがアプリ内で成立するか確認
#   (ハーネストestは「外部から」APIへ繋ぐだけなので、UI内での同時実行の検証はここしかない)

# Phase 2: 画像検出ロジック(API不要・純粋ロジック)
npm run phase2:detect

# Phase 3: Vision Bridgeパイプライン(API不要・純粋ロジック)
npm run phase3:bridge

# Phase 4: Blender MCP実機E2E(詳細はTESTING.md §Phase 4)
```

## 第三者への引き渡し

- **フォルダごとzip等で渡すこと**（`node_modules/` と `.lmstudio/` を含める）。
  - `git` 経由で渡すと `.gitignore` が `node_modules/` と `.lmstudio/`（hostブートストラップ）を除外するため、
    相手の環境でプラグインが読み込めない／ハーネスが走れない状態になります。
- 受け取る側には README の「**モデル名・API先を変える場所**」を読むよう伝えてください
  （自分のロード済みモデルIDとサーバーポートを `config.json` や環境変数で設定する）。
- LM Studioはプラグイン機能のある**同じ世代のバージョン**が必要（古いバージョンではAPI自体が存在しない）。
- 本プロジェクトの独自コードには LICENSE ファイルを付けていません。
  第三者への利用許諾は、譲渡時の合意（口頭でも可）に基づきます。
  同梱の依存パッケージ（`@lmstudio/sdk` 等）は各自のライセンス（Apache-2.0 等）に従います。
- セキュリティ面: ネットワーク通信はすべて `127.0.0.1` へのループバックのみ。
  外部送信・UI自動操作・MCPクライアント実装は行いません（詳細は `docs/architecture.md`）。

## 最大の未確認事項とフォールバック

> **Generator Pluginから、同じLM Studioインスタンスのlocalhost APIへ投げる折り返しが
>  並列(同時実行)で成立するか** — 作者環境では**成立を確認済み**（UI内で応答が返る）。
>  ただしLM Studioのバージョン・モデル・設定によってはキューでブロックされる可能性がある。

想定される失敗モードと対処:

| 症状(ログ) | 読み | 対処 |
|---|---|---|
| `api_connect_failed` | API未起動/ポート違い | LM Studioのサーバー有効化・`apiRoot`確認 |
| `api_error ... model not found` 等 | `model`設定がロード済みモデルと不一致 | `model` をロード済みモデルIDに変更(上記「モデル名・API先を変える場所」) |
| `api_error 503 ...` / `api_queued (202)` | 現行ターンがモデルを占有し、内部リクエストがキューでブロック | フォールバック: `proxy/fallback-proxy.mjs` + `apiRoot`差し替え |
| `api_timeout` | 同上の無応答版(デッドロック) | 同上 |
| `no tool-call reporting method found` | hostのSDKメソッド名が想定と違う | ログの `availableKeys` を見て `src/controller.ts` の `REPORT_METHODS` を追加 |

フォールバックの設計思想: **MCP実行は常にLM Studio側に残す**。
折返し先だけ「別プロセス/別インスタンス」にする(薄いプロキシまたは第二インスタンス)。
詳細: `proxy/README.md` と `TESTING.md §Fallback`。

## やらないこと(設計の境界)

- MCPクライアント全体の再実装
- Blender MCP専用実装(任意のMCP ImageContent返却ツールに対応する設計)
- UIのマウス操作・自動クリック
- クリップボード経由の画像貼り付け
- 常時フォルダ監視だけでタイミングを推測する方式
- LM Studio内部ファイルの直接改造
- tool resultの型制約を破って画像を直接付加する方式
- 巨大フレームワークの導入
