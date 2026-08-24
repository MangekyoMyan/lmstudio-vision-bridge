# テスト手順 (Vision Bridge)

前提: **Node.js 20.6+**（ハーネス実行時）/ LM Studio起動 / Qwen3.8-27Bロード済み / ローカルサーバー有効(既定 `127.0.0.1:1238`)。
以降、ルートディレクトリ `MCP_qwen3.8/` を作業ディレクトリとする。

> Node 18系を使う場合は `--import ...` を `--experimental-loader scripts/harness/loader-hooks.mjs` に置き換える。
>
> **重要**: ハーネストest（`npm run phase*`）は `vision-bridge/build/` のJSミラーを実行対象にする。
> `src/*.ts` を編集した直後は必ず先に `npm run build`（ルート）でミラーを再生成すること。
>
> **別環境で実機テストする場合は**: `model`（既定 `qwen/qwen3.8-27b`）と `apiRoot`（既定 `127.0.0.1:1238`）を
> 自分の環境に合わせる（`VISION_BRIDGE_MODEL` / `VISION_BRIDGE_API_ROOT` 環境変数、または
> `<working directory>/.vision-bridge/config.json`）。詳細は README「モデル名・API先を変える場所」。

---

## Phase 0 — API疎通確認

```bash
npm run api:smoke
```

期待される出力:
```
API OK (200) at http://127.0.0.1:1238
models: qwen/qwen3.8-27b, ...
```

- `cannot reach ...` → LM Studioの「ローカルサーバー」が有効か/ポートを確認
  （別ポートで運用している場合は `VISION_BRIDGE_API_ROOT` を合わせる）
- `models: (no loaded model ...)` → Vision対応モデルをロードする
- **`models:` に載ったIDが、プラグインの `model` 設定と一致しているか確認**
  （不一致のままだと折返しが「model not found」等で失敗する。README「モデル名・API先を変える場所」参照）

---

## Phase 1 — 折り返し推論(最小検証)

### 1a. テキスト推論(ハーネス=LM Studio外部)

```bash
npm run phase1:text
```

このテストがやっていること:
1. mock controller(working directory = 一時ディレクトリ)で `VisionBridgeGenerator` を構築
2. `generate([user: "Respond with exactly the token BRIDGE-OK ..."])` を呼ぶ
3. Generatorが **`127.0.0.1:1238/v1/chat/completions` へ折り返し** し、ストリーム応答を消費
4. tool callループの疑似検証:
   - `ctl.tools` にMCP風ツールを設定してgenerate → **tool callが `report_tool_call` 経由で報告されるか**
   - tool result(assistant+toolメッセージ)を含む履歴で再びgenerate → **tool resultの変換・2ラウンド目**が壊れないか

判定:
- `PASS loopback text inference works` → 折り返しAPI通信が外部から成立(最重要)
- `PASS model produced the marker token` → モデルが実際に応答(soft: 失敗でもWARN扱い)
- `PASS generator reported a tool call` / `PASS tool result round-trip works` → tool callingループの基礎

> **LM Studio未起動/実機検証前にパイプラインだけ決定的に確認したい場合**:
> `npm run phase1:text -- --mock` で、同プロセス内のモックOpenAI API(既定 127.0.0.1:18999)
> へ折り返し、HTTP + SSEストリーミング + tool call + tool result 変換の全パイプラインを
> モデルなしで検証できる(全チェックがハードアサーション)。
> 実機UI内の同時実行(最大の未確認事項)の検証は Phase 1c にそのまま残る。

### 1b. Vision入力(ハーネス)

```bash
npm run phase1:vision
```

このテストがやっていること:
1. 自動生成した **赤/青2分割PNG**(fixtures)をworking directoryへ置く
2. **手動添付相当**の経路: user messageのfile partとして画像 → Generator経由でQwenへ → 左右の色を答えてもらう
3. **MCP画像相当**の経路(= Phase 2/3の早期E2E): 偽のtool result( `![screenshot](scene.png)` )を履歴に載せ、
   bridgeが画像を検出してsynthetic messageを挿入した上でQwenへ送る

判定: 両シナリオで色(red/blue)の認識がPASSすれば、「画像がQwenのVision入力として
認識される」が成立したことになる。
失敗時はTESTING.md末尾の診断表参照(モデルがVision非対応ではないか? data URL形式の相性? を確認)。

> `npm run phase1:vision -- --mock` → モックモデル側が「image_url data URLを
> 実際に見ているか」を構造的に検証(実機なしでデータパスの確認が可能)。

### 1c. 【最重要】LM Studio UI内の折り返し(並列性)

> ハーネストestは「LM Studioの外から」APIに繋ぐので、**アプリ内のgenerate実行中に
>  同じインスタンスのAPIに投げる並列(同時実行)が成立するか** はここでは証明できない。
> これが「最大の未確認事項」であり、ここだけが最終検証になる。

手順:
1. LM Studio → Plugins → `vision-bridge` フォルダをGeneratorプラグインとして追加
2. Qwen3.8-27Bで新規チャットを開き、**Generator=本プラグイン** を選択
3. `BRIDGE-OK とだけ答えて` と送信
4. 応答が返ってくる ⇒ **折り返しは成立**
5. タイムアウト/ハングする ⇒ 下記 Fallback

診断ログ: `<prediction の working directory>/.vision-bridge.log`
- `api_queued (HTTP 202)` / `api_error 503` → モデルの占有・キューによるデッドロックを疑う。`api_timeout` は `timeoutMs > 0` のときだけ発生
- `api_connect_failed` → サーバー未起動/ポート違い → `apiRoot` を確認
- `api_error ... model not found` 等 → `model` 設定がロード済みモデルと不一致 → 設定を合わせる

### 1d. 公式 generate() + SDK Chat形状（決定論的・モックAPI）

```bash
npm run phase1:sdkchat
npm run phase1:messages
```

このテストがやっていること:
1. `src/index.ts::generate`（buildミラー経由）を、@lmstudio/sdk の `Chat` クラス形状の
   スタンイン（`getMessagesArray` / `getRole` / `getText` / `getToolCallRequests` /
   `getToolCallResults` / `getFiles`）で駆動する
2. 現行host APIの `fragmentGenerated` / `toolCallGenerationStarted→Name→ArgumentFragment→Ended`
   でテキスト・tool callが返ることを確認
3. 空履歴のガード（POSTせず⚠️fragment）、user添付画像のdata URL化、MCP画像のsynthetic注入、
   空content messageの正規化（ワイヤ上は必ずstring/array、null/objectでない）を検証

判定: `ALL CHECKS PASSED`。これは「実hostのAPI表面が想定通りか」の最良の代替検証であり、
最終確認は Phase 1c（実UI）で行う。

---

## Phase 2 — MCP画像検出(ロジック検証、API不要)

```bash
npm run phase2:detect
```

一時ディレクトリに `scene.png` / `assets/render_001.png` / `my shot.png` / `notes.txt` / 古い `old.png` を作り、
tool resultの各種表現(markdown参照 / `fileName:` 形式 / URLエンコード名 / 複数画像 / 非画像参照 / 参照なし)
に対する **参照抽出→working directory内ファイルへの対応付け** を検証する。

設計上、**「フォルダ内最新画像を無条件選択」はしない**:
1. 完全一致(相対/絶対パス)
2. glob(`*`)
3. ファイル名一致(同名が複数あればmtime新しい方)
4. 文字列部分一致(最後にするフォールバック)
の順に、**tool resultに書かれた参照情報** から解像する。

## Phase 3 — Vision Bridgeパイプライン(ロジック検証、API不要)

```bash
npm run phase3:bridge
```

- tool result画像参照を含む履歴 → `applyVisionBridge` → **末尾にsynthetic user message** が1つだけ追加される
  (text = 注記、`image_url` = `data:image/png;base64,...`)
- 同一履歴の再実行 → **同一画像は重複スキップ**(内容hash)
- 新しいtool result(別画像)を追加した履歴 → **新規画像だけ**が投入される(既存はスキップ)
- synthetic messageは **送信コピー에만** 存在し、入力の履歴配列は変更されないことを確認

## Phase 4 — Runtime / GUI control (API mock)

```bash
npm run phase4:control
```

決定論的なmock SSE serverを使い、以下を確認する。

1. reasoning-only stream eventが `~/.vision-bridge/runtime.json` に `reasoning` として記録される
2. `timeoutMs=0` で静かなlong-running requestが自動中断されない
3. GUIと同じ `~/.vision-bridge/control.json` 方式でactive invocationをAbortできる
4. Abort後のruntime phaseが `aborted` になる

> reasoning本文はruntimeへ保存しない。activity event数/文字数だけを記録する。

## Phase 5 — Blender MCP 実機E2E

1. LM StudioでBlender MCPが有効な状態(従来どおりMCP動作することを確認)
2. UIでQwen3.8-27B(Generator=本プラグイン)に:
   - 「Blenderで立方体を作成し、ビューポートのスクリーンショットを返して。画面に何が映っているか説明して」
3. 期待される流れ:
   - Qwenがtool callを生成 → Generatorが報告 → LM StudioがBlender実行 → 画像がworking directoryへ保存
   - 再呼出時に `image reference(s) detected` → `image candidate adopted` → `VISION MESSAGE INJECTED`
   - Qwenが **画像内容(立方体)を認識して説明** する
4. 続けて「90度回して、もう一度スクリーンショットを返して。先ほどと何が違う?」
   - 追加tool call → MCPループ継続 → **新しいレンダ** は投入され、**同一レンダは再投入されない**
   (ログに `DUPLICATE image skipped` がでるかどうかで重複防止の効きを確認)
5. テキストだけのMCPツール(例: シーン情報の取得)でも従来通り応答できることを確認(画像なし→履歴無変更)

---

## 診断表

| 症状 | 主な原因 | 対処 |
|---|---|---|
| `cannot reach LM Studio API` | サーバー未起動・ポート違い | LM StudioローカルサーバーON、`apiRoot`確認（別ポート運用なら `VISION_BRIDGE_API_ROOT`） |
| `LM Studio API returned 503` | モデル占有/未ロード | モデルロード確認。持続すればFallback |
| `api_error ... model not found`（404系） | `model` 設定とロード済みモデルIDの不一致 | `model` をロード済みモデルIDに変更（README「モデル名・API先を変える場所」） |
| `request was queued (HTTP 202)` | 折り返しがキューで待機 | GUI状態・ログ確認。必要ならFallback |
| `api_timeout` | `timeoutMs > 0` のabsolute timeout超過 | timeoutを延長/0で無効化。GUIで状態確認・手動Abort |
| tool callが報告されない | host SDKのメソッド名違い | ログ `availableKeys` を見て `src/controller.ts` の `REPORT_METHODS` に追加 → build同期 |
| 「no tool definitions found」 | controllerにツール定義がない | generateの引数/controller表面を確認。`getModelInfo`ログでhostの形状を確認 |
| 画像が検出されない | tool resultの表現が想定外 | ログ `values` を見て `src/image-detect.ts` のregexを追加 |
| 検出されるが投入されない | 重複スキップ/サイズ超過/読み込み失敗 | ログ `DUPLICATE image skipped` / `size` / `failed to encode` を確認 |
| モデルが画像の内容に反応しない | モデルがVision非対応 / data URL非対応 | 手動添付で同じ画像が認識できるか確認(= Phase 1bの手動経路) |

## Fallback(折り返しデッドロック時のみ)

1. 第二の推論先を用意する:
   - 別ポートの第二LM Studioインスタンス(Qwen3.8-27Bをもう一度ロード)、または
   - `lms serve` 等による別サーバ。MCP実行は **元のLM Studioに残す**
2. `proxy/fallback-proxy.mjs` を起動:
   ```powershell
   $env:PROXY_TARGET="http://127.0.0.1:18081"   # 第二推論先
   node proxy\fallback-proxy.mjs                  # 127.0.0.1:18080 で待ち受ける
   ```
3. `<working directory>/.vision-bridge/config.json` に `{ "apiRoot": "http://127.0.0.1:18080" }`
4. UIで再テスト。MCPループ(5.〜8.の手順)はそのまま使える
