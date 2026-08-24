# AI_STATUS — Vision Bridge current state

> 更新: 2026-08-25
> 次のAIは、コード編集前にこのファイルと `AI_README.md` を読むこと。

## 1. 目的

LM StudioのMCPツールがworking directoryへ保存した画像を、Generator Pluginが検出し、
**LM Studioへ送る履歴のコピーだけ**にsynthetic user + `image_url`として挿入する。
MCP実行そのものはLM Studioに残す。

```text
LM Studio Chat
  -> Vision Bridge Generator
  -> localhost OpenAI-compatible API
  -> loaded Vision model
  -> tool callをGeneratorControllerへ返す
  -> LM StudioがMCP実行
  -> tool result画像をVision Bridgeが次ラウンドで注入
```

## 2. 現在の状態

| 項目 | 状態 |
|---|---|
| 現行LM Studio Generator API (`withGenerator`) | ✅ |
| SDK Chat -> OpenAI message変換 | ✅ |
| MCP画像参照検出 / data URL注入 | ✅ |
| SHA-256重複排除 | ✅ |
| tool callをLM Studioへ返す | ✅ |
| mock harness | ✅ 全テスト通過 |
| GUI Control Panel | ✅ 追加 |
| absolute timeout無効化 (`timeoutMs=0`) | ✅ 既定 |
| GUIから手動Abort | ✅ mock test済み |
| reasoning stream活動の可視化 | ✅ 本文は表示せずactivityのみ |
| `src/` と `build/` | ✅ 同期済み |

## 3. 最初に実行するテスト

`src/*.ts` を変更したら必ず先にbuildする。

```bash
npm run build
npm run phase2:detect
npm run phase3:bridge
npm run phase1:messages
npm run phase1:text -- --mock
npm run phase1:vision -- --mock
npm run phase1:sdkchat
npm run phase4:control
```

`phase4:control` は以下を決定論的に確認する:

- reasoning-only SSE activityがruntime statusに出る
- `timeoutMs=0` なら長時間リクエストを勝手に切らない
- `~/.vision-bridge/control.json` 経由のGUI Abortでrequestを停止できる

## 4. 重要なファイル

### Plugin

| File | Responsibility |
|---|---|
| `vision-bridge/src/index.ts` | 現行host entry / history adapter / runtime telemetry / Abort連携 / tool call reporting |
| `vision-bridge/src/openai-client.ts` | localhost API / SSE / reasoning activity検出 / timeout / external Abort / loopback-only guard |
| `vision-bridge/src/runtime-state.ts` | GUIとPluginのcross-process runtime/control JSON |
| `vision-bridge/src/vision-bridge.ts` | MCP画像 -> synthetic user message注入 |
| `vision-bridge/src/image-detect.ts` | tool resultの画像参照抽出・解決 |
| `vision-bridge/src/dedup.ts` | 画像内容SHA-256重複排除 |
| `vision-bridge/src/messages.ts` | LM/SDK history -> OpenAI wire format |
| `vision-bridge/src/config.ts` | env / project / user config読み込み |
| `vision-bridge/src/controller.ts` | controller API compatibility adapter |
| `vision-bridge/src/generator.ts` | legacy/harness generator |

### GUI

| File | Responsibility |
|---|---|
| `vision-bridge/gui/server.mjs` | 127.0.0.1:19280 local GUI server / config / Abort / dedup reset / optional `lms dev` spawn |
| `vision-bridge/gui/public/*` | Control Panel frontend |
| `start-vision-bridge-gui.cmd` | Windows one-click launcher |

### Tests

`./scripts/harness/`。特に:

- `message-normalize-test.mjs`
- `phase1-sdkchat-test.mjs`
- `phase4-control-test.mjs`

## 5. 絶対に壊さない不変条件

1. **GeneratorはMCPを実行しない。** tool callをLM Studioへ報告して停止する。
2. **LM Studio UIの永続履歴をmutateしない。** Vision注入は送信コピーのみ。
3. tool role messageへ画像を直接付けない。synthetic user方式を使う。
4. 画像はtool resultの参照から解決する。「フォルダ内の最新画像を無条件採用」はしない。
5. 画像の重複判定は**実ファイル内容SHA-256**。
6. 画像読み込み/encoding成功前にseen登録しない。
7. OpenAI wire `content` はnull/raw objectを送らない。user Visionのみtext/image_url配列可。
8. 推論APIはloopbackのみ。画像をremote endpointへ送らない。
9. `src`変更後は`npm run build`して`build`を同期する。
10. telemetry/controlの失敗で本体のgenerationを壊さない。

## 6. Config

優先順位:

```text
environment
> <working directory>/.vision-bridge/config.json
> ~/.vision-bridge/config.json
> defaults
```

現在の主な既定値:

| key | default |
|---|---|
| `apiRoot` | `http://127.0.0.1:1238` |
| `apiKey` | `lm-studio` |
| `model` | `qwen/qwen3.8-27b` |
| `timeoutMs` | `0` (absolute timeout disabled) |
| `maxImageBytes` | 20MB |
| `logLevel` | `info` |
| `bridgeEnabled` | `true` |
| `requoteOriginalRequest` | `true` |

### 修正済みConfigバグ

以前はconfigのmerge順が逆で、`~/.vision-bridge/config.json` がworking-directory configを上書きしていた。
現在はコメント/READMEどおり **working directory側がuser configより優先**。

## 7. GUI / runtime protocol

共有ファイルはuser home:

```text
~/.vision-bridge/runtime.json
~/.vision-bridge/control.json
~/.vision-bridge/config.json
```

`runtime.json` にチャット本文・画像data URL・API keyは保存しない。
主なphase:

```text
preparing -> connecting -> connected -> reasoning/generating/tool_call -> completed
                                                   \-> aborted / error
```

heartbeatは約1秒ごと。モデルがreasoning streamを出す場合は`reasoning` phaseへ移る。
モデルが何もstreamしない場合でもheartbeatとHTTP connected状態は見える。

### GUI Abort

GUIはactive `invocationId` を `control.json` へ書く。
Plugin側は約500ms周期でpollし、対象invocationならAbortControllerをabortする。
LM Studio自身の`ctl.abortSignal`も同じrequest AbortControllerへ連結する。

## 8. 今回修正した主な不具合

1. **5分absolute timeout問題**
   - 旧: `AbortSignal.timeout(300000)` 固定に近い挙動
   - 新: `timeoutMs=0`で無制限。正値を指定した場合だけabsolute timeout。

2. **長考/停止が見えない問題**
   - runtime telemetry + GUI追加。
   - heartbeat / connected / network activity / reasoning activity / text / tool activityを分離表示。

3. **Config優先順位の実装がコメントと逆**
   - user config -> working configの順にmergeするよう修正。

4. **同一パス・同一byte数で画像内容が変わった場合のhash cache誤判定**
   - 旧: path+sizeだけでhash cache。
   - 新: 毎回実ファイルbytesをSHA-256。

5. **既に`image_url`化されたuser contentを`toOpenAIMessage()`が落とす**
   - `image_url.url`をそのまま保持するよう修正。

6. **message typeの`content:null`余地**
   - `OpenAIChatMessage.content`をstring/partsのみにし、初期値も空stringへ統一。

7. **phase1:sdkchat harnessのtool args想定**
   - current host APIがobject argumentsを返すケースも許容するようtestを修正。

## 9. セキュリティ

`openai-client.ts` は非loopback `apiRoot` を拒否する。
許可host:

- `localhost`
- `127.x.x.x`
- `::1`

GUI serverも `127.0.0.1` のみにbind。

## 10. 既知の限界

- reasoning textそのものはGUIへ出さない。activityの有無と量だけ。
- LM Studio/モデルが長考中に**何のSSE eventも送らない場合**、Bridgeは「内部で正常に思考中」か「LM Studio内部待機中」かを100%識別できない。
  ただしBridge heartbeat、HTTP接続、最後のnetwork/model activityは別々に確認できる。
- GUIは現状Electron等のnative exeではなく、Node標準HTTP server + browser UI。外部GUI依存を追加していない。
- `lms dev` の起動可否はLM Studio CLIがPATHにあることに依存。

## 11. 実機確認で見るもの

1. `start-vision-bridge-gui.cmd`
2. GUIが `127.0.0.1:19280` で開く
3. `lms dev` logが表示される
4. LM StudioでVision Bridge Generatorを選ぶ
5. 長考時にheartbeatが更新され続ける
6. reasoning対応backendなら`REASONING`になる
7. GUI AbortでLM Studio側のpredictionが停止する
8. Blender MCP画像が`injectedImages`へ出る
9. MCP tool call後に次roundへ継続する

