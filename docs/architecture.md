# アーキテクチャと設計判断

## 責務分離(最重要原則)

```
Qwen ──tool call生成──► Generator ──report_tool_call──► LM Studio ──MCP実行──► 画像保存
  ▲                                                                             │
  └────────────── 2. 更新済み履歴で再呼出 ◄──────────────────────────────────────┘
```

- **MCP実行はGeneratorが絶対にやらない**(LM Studio既存機能に委任)
- **tool resultに画像を直接付加しない**(LM Studio SDKの型制約: toolメッセージには画像を付けられない)
  → 代わりに「synthetic user message」方式(第一候補、要件どおり)
- **UIの永続履歴には触れない**: 加工は「Qwenへ送るコピー」だけで行う
  (Generatorは履歴の *配列* を受け取り、新しい配列をAPIへ送るだけ)

## なぜ折り返し(Loopback)か

- LM Studio Generatorは「モデル推論」そのものをラップできる
- Qwen3.8-27Bは同じLM Studio内でロード済み → 外部モデル不要、MCPも既存のまま
- 公式の openai-compat-endpoint Generator の思想(履歴変換・tool定義転送・streaming・
  tool call報告)をそのまま踏襲し、**折り返し先を localhost にする** のが本設計の核心
- リスク: 「generate実行中に同じインスタンスのAPIへ投げる」並列性が未検証 → Phase 1cで実機確認、
  失敗時は薄いプロキシ経由で第二推論先へ(責務分離は維持)

## SDKの不確実性への対策(アダプタ)

### 現行host API(2026-07時点・作者環境で確認済み)

現行プラグインホストは `@lmstudio/sdk`(1.4.0系) の self-registration API を使う:

| 機能 | 位置 | 挙動 |
|---|---|---|
| 登録 | `src/index.ts::main(context)` | `context.withGenerator(generate)` を呼ぶ(公式 openai-compat-endpoint と同一API) |
| ストリーム返却 | `src/index.ts::generate` | `ctl.fragmentGenerated(text)` |
| tool call報告 | `src/index.ts::reportToolCallNewApi` | `toolCallGenerationStarted → NameReceived → ArgumentFragmentGenerated → Ended({type,id,name,arguments})` |
| 履歴 | `src/index.ts::sdkChatToPlainMessages` | SDK `Chat` クラス(`getMessagesArray` / `getRole` / `getText` / `getToolCallRequests` / `getToolCallResults` / `getFiles`)をプレーンなOpenAI風メッセージへ変換 |
| hostブートストラップ | `.lmstudio/entry.ts` | `lms dev` が生成。`../src/index.ts` の `main(pluginContext)` を呼ぶ |

### レガシー(旧beta)フォールバック経路

hostが注入する `lmstudio` SDK(旧beta)の正確な表面(メソッド名・メッセージ形状)は環境依存のため、
**全部を1箇所のアダプタに集約** している:

| 機能 | 位置 | 挙動 |
|---|---|---|
| working directory取得 | `src/controller.ts::getWorkingDirectory` | `getWorkingDirectory()` / `get_working_directory` / プロパティ順にprobe |
| tool call報告 | `src/controller.ts::reportToolCall` | `report_tool_call` 等の候補メソッド × `{id,tool,args}` と OpenAI風ペイロードの順に試行、成功した経路をログ記録 |
| ツール定義取得 | `src/controller.ts::getControllerTools` | controllerの `tools` 系propr / generateの追加引数 |
| Generator基底クラス | `src/generator.ts` | hostに `Generator` があれば継承、なければ最小shimを継承(いずれでも `super(ctl)` が通る) |
| toolメッセージ | `src/messages.ts::toOpenAIMessage` | `tool_call_id` / `toolCallId` / `call_id` を順にprobe |

→ 環境差異が起きても **`src/index.ts` の新API経路 / `src/controller.ts` の配列1本(または `messages.ts` のkey順)で直る** 設計。

## 画像の特定(Phase 2)方針

「フォルダ内最新画像の無条件選択」は **しない**。tool resultが持つ参照情報と対応付ける:

1. `extractImageRefs`: tool resultのテキストから
   - Markdown画像参照 `![...](path)`
   - `fileName: xxx` / `image file: xxx` 形式
   - 画像拡張子付きパストークン(フォールバック)
   を抽出。加えて **content配列内のfile part** (path/file_name) もrefとして拾う
2. `resolveImages`: working directoryを walk(深さ4/20000ファイル上限、隠しディレクトリ除外)し、
   参照→ファイルの対応付け(完全一致→glob→basename→部分一致)。
   同名複数ならmtime新しい方を採用。サイズ上限チェック。
3. 結果は **絶対パス・相対パス・mimeType・サイズ・マッチ経路** を持つ `ResolvedImage[]` になる
   (複数画像対応: 最大8枚)

## 重複防止(Phase 3)

- `SeenTracker`: **画像ファイルの内容SHA-256** を主キーに「投入済み」を管理
  - 同パスでも **内容が変われば再投入** する(Blenderが上書き保存して新しいレンダの場合)
  - 同内容なら **スキップ**(ログ: `DUPLICATE image skipped`)
- 状態は `<working directory>/.vision-bridge/state.json` に永続化
  (Generatorインスタンスがpredictionごとに新生されても、同一predictionの履歴では効く)
- tool call ID も併記(追跡・診断用)

## synthetic message の形

```
assistant:  (tool call)
tool:       (tool result — 画像参照を含む)
user:       [Vision Bridge internal message]
            This is not a new user request.
            The attached image is the visual output returned by the immediately preceding MCP tool call.
            ... (注記・継続指示)
            <image_url: data:image/png;base64,...>
```

- 挿入位置: **直前のtoolメッセージの後**(=通常は末尾)。履歴の他部分は一切変更しない
- 画像1枚もない/全部重複 → 何も挿入せず **履歴そのまま** で推論(=テキストMCPの従来動作)
- `requoteOriginalRequest`(既定 `true`)の場合: **直前のuserリクエストを逐語引用**して注記する
  (`findOriginalPendingRequest` が最後のtoolメッセージより前の最後のuserテキストを抽出)。
  モデルが「画像の説明だけで止まる」挙動を減らす狙い。`false` にすると `syntheticText` のみになる。
  ※ 2026-07時点では `src/` と `.lmstudio/dev.js` にのみ存在し `build/` ミラーには未反映(ハーネスは旧挙動で検証)

## 意図的に置かないもの

- UI自動操作・クリップボード・常時フォルダ監視: タイミング推測が怪しく、要件でも除外
- 巨大フレームワーク: Generator本体は `node:*` + fetch のみ(依存パッケージは開発用のTypeScriptだけ)
- MCPクライアント実装: 触れない
