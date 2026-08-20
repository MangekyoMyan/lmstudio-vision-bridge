# STATUS — Vision Bridge（LM Studio MCP画像 → Vision入力）

> **次のAIへ：このファイルを読み、§3「実行順」と§5「不変条件」だけで動けることを目指した要約。**
> 更新時点（2026-07-09）＝プラグイン実装・テスト作成は完了、**作者環境での基本動作（UI内折り返し含む）を確認済み**。
> 詳細設計は `docs/architecture.md`、手順は `TESTING.md`、第三者引き渡しの手順は README「モデル名・API先を変える場所」。

---

## 1. 目的（3行）

LM StudioのMCPツール（Blender MCP等）が返した画像は working directory に保存されるが、
Visionモデル（Qwen3.8-27B）の画像入力として渡されない。
本プラグインは **Generatorとしてモデル推論をラップ**し、Qwenへ送る履歴の**コピー**に
「画像付きsynthetic user message」を挿入してVision入力へ復元するだけ。
**MCP実行・MCPクライアントは完全にLM Studio側に残す（再実装しない）。**

折り返し構造：`LM Studio Chat → Generator → localhost OpenAI互換API(127.0.0.1:1238) → ロード済みのQwen`

## 2. 現在の位置（更新 2026-07-09）

| Phase | 状態 | 備考 |
|---|---|---|
| プラグイン実装（折り返し/検出/注入/重複排除） | ✅ 完成 | **現行host APIに対応済み**：公式entry `src/index.ts`（`main(context)` → `withGenerator`、`fragmentGenerated`、`toolCallGeneration*`、SDK Chatアダプタ）。旧beta APIは `src/generator.ts` + `src/controller.ts` にレガシーフォールバックとして維持 |
| テストスクリプト7本＋モックAPI | ✅ 完成 | phase1:text / phase1:vision / phase1:sdkchat / phase1:messages / phase2:detect / phase3:bridge / api:smoke。**ハーネストestの実行対象は `build/` ミラー** |
| 文書（README/architecture/TESTING） | ✅ 完成 | 2026-07-09に現状同期済み（モデル名・API先の設定手順をREADMEに明記） |
| フォールバックプロキシ | ✅ 完成（未使用想定） | 折り返しデッドロック時のみ起動 |
| `node_modules`（typescript / @lmstudio/sdk 1.4.0） | ✅ 導入済み | `npm run build` で `build/` 再生成可能 |
| **作者環境での動作確認** | ✅ **成立** | UI内折り返し（旧「最大の未確認事項」）を含む基本動作を作者環境で確認 |
| **`build/` と `src/` の同期** | ⚠️ **未同期** | `requoteOriginalRequest`（後日追加・既定true）が `src/` と `.lmstudio/dev.js` にはあるが `build/` には**無い**。ハーネス＝旧挙動でテストされている。`npm run build`（ルート）で再生成 | **再生成前にハーネス実行する** |
| Phase 4：Blender MCP実機E2E | △ 要確認 | 作者環境で基本動作確認済みだが、Blender実機での全E2E（90度回転等の続行・DUPLICATE確認）は第三者環境で再確認が望ましい |

**完成条件**：UIでQwen会話可／既存MCPをQwenから呼べる／テキストMCP結果が従来通り／
MCP画像を自動検出＆Qwen Vision入力で届く／Qwenが画像内容を認識して判断／
追加tool callでMCPループ継続／同一画像の重複投入なし。

## 3. 次のAIの実行順（最重要）

```bash
cd F:\AI\MCP_qwen3.8        # Windows: F:\AI\MCP_qwen3.8

# (A) モデル不要・決定論的 → まずここ
# ※ src/*.ts を編集した直後は、必ず先に `npm run build` で build/ ミラーを同期する
#   （ハーネストestは vision-bridge/build/ を実行対象にするため）
npm run build                    # src/ → build/ ミラー再生成（srcを触った後）
npm run phase2:detect            # 画像検出ロジック（API不要）
npm run phase3:bridge            # 注入・重複排除・履歴不変（API不要）
npm run phase1:messages          # 変換・型正規化（contentがnull/objectにならない、API不要）
npm run phase1:text -- --mock    # 折り返しHTTP+SSE+tool call（モックAPI 127.0.0.1:18999）
npm run phase1:vision -- --mock  # Visionデータパス（モックがdata URLを「見た」か）
npm run phase1:sdkchat           # 公式SDK Chat経路（空content正規化シナリオ8含む）

# (B) LM Studio起動中（Qwen3.8-27Bロード済み・ローカルサーバーON）なら実機
npm run api:smoke                # API疎通＋モデル確認
npm run phase1:text              # 実機折り返し（モデル応答チェックはsoft）
npm run phase1:vision            # 実機Vision（red/blue認識で判定）
```

**次に手動（ユーザー）：**
1. **Phase 1c**：LM Studio → Plugins → `vision-bridge` フォルダをGeneratorプラグインとして登録
   （エントリは `src/index.ts` の `main(context)`、hostブートストラップ `.lmstudio/entry.ts` 経由）
   → 対象モデルのチャットでGenerator選択 →「BRIDGE-OK とだけ答えて」→ 応答返れば**折り返し並列性は成立**。
   ハング/503/202 → `proxy/fallback-proxy.mjs`（`TESTING.md §Fallback`）。
   ※ 別環境では先に `model` / `apiRoot` を自分の環境に設定すること（README「モデル名・API先を変える場所」）。
2. **Phase 4**：Blender MCPで「立方体を作ってスクリーンショット返して、内容説明して」→
   続けて「90度回して再スクショ、何が違う？」（新しいレンダ投入／同一レンダは
   `DUPLICATE image skipped` でスキップされること）＋テキストMCPツールが従来通り。

**テストがFAILしたときの鉄則：**
- まず `<working directory>/.vision-bridge.log`（+コンソール）の該当行を読む。
- ハーネスト（`scripts/harness/*`）側の不備か、プラグイン（`vision-bridge/src/*`）側の不備かを切り分ける。
  ※テストスクリプトはレビューベースで書かれたため、**初回実行でハーネス側のtypo・想定違いが出る可能性が高い**。
  その場合はハーネストを直して再実行（プラグインの設計を壊さないこと）。
- 症状別対処は `TESTING.md 末尾の診断表`。

## 4. ファイルマップ（各1行职责）

### ルート
| ファイル | 职责 |
|---|---|
| `package.json` | npm scripts: `api:smoke` / `phase1:text` / `phase1:vision` / `phase2:detect` / `phase3:bridge`（参照先スクリプトは全部実在する） |
| `README.md` | 概要・セットアップ・設定テーブル |
| `TESTING.md` | Phase別手順・判定・診断表・Fallback |
| `docs/architecture.md` | 設計判断（責務分離/折り返し理由/アダプタ戦略/重複排除方針） |

### `vision-bridge/`（プラグイン本体）
| ファイル | 职责・中身 |
|---|---|
| `index.ts` | **レガシーエントリ（旧beta API）＋named exports集**。ハーネス・プログラム再利用向け。hostは読まない（hostは `src/index.ts` を読む） |
| `src/index.ts` | **★公式エントリ**。`main(context)` → `context.withGenerator(generate)`。`generate(ctl, chat)`：①`chat`がSDK `Chat`クラスなら `sdkChatToPlainMessages` でプレーン形式へ（user添付画像はfile part化）②空履歴ガード（POSTせず⚠️fragment）③`applyVisionBridge`④tools取得 ⑤`chatCompletionStream`でloopbackし`ctl.fragmentGenerated`でストリーム返却 ⑥tool callは `toolCallGenerationStarted→Name→ArgumentFragment→Ended`（現行API）で報告して停止、失敗時はレガシーprobe（`src/controller.ts`）へフォールバック |
| `src/generator.ts` | **レガシー** `VisionBridgeGenerator`（旧beta API・yield型）。ハーネストest（phase1:text/phase1:vision）の実行対象。generate()毎：①`applyVisionBridge` ②tools取得 ③loopback ④yield ⑤`reportToolCall(ctl)`で報告して**即停止**。`AsyncQueue`+sentinel（`__VB_END__` / `__VB_ERR__:`）で非同期ブリッジ |
| `src/openai-client.ts` | loopbackクライアント。`POST {apiRoot}/v1/chat/completions`（`stream:true`）。SSEは `data:` 行パース（`\n`分割+末尾バッファ、`[DONE]`無視、裸data:も許容）。非stream JSONフォールバック。tool_callsは index 単位の増分アセンブル。エラーコード：`api_connect_failed` / `api_timeout` / `api_queued`(HTTP 202) / `api_error` / `api_bad_json`（ログで区別できる） |
| `src/messages.ts` | LM↔OpenAI変換。`toOpenAIMessage`（**toolメッセージに画像を絶対に付けない**→file partは`[attached file: ...]`テキスト化。assistantは`toolCallRequest`/`tool_calls`両対応→`tool_calls`。toolは`tool_call_id`/`toolCallId`/`call_id`順にprobe、無ければ`call_vb_t{index}`）、`toOpenAITools`（LM/OpenAI両対応）、`fileToDataUrl`（base64 data URL）、`normalizeToolCallAny`、`guessMime`。Windowsドライブ文字(`C:\`)対応 |
| `src/image-detect.ts` | Phase 2。`extractImageRefs`（markdown `![]()`／`fileName:`系／拡張子付きパストークン）、`extractFilePartRefs`（content配列のfile part: path/file_name/name/url）、`resolveImages`。**解決優先度：exact → glob → basename(同名はmtime新し方) → suffix retry（path-tokenで空白含む時、後方語順に再試行）→ substring（path-tokenのみ）**。`refsFromToolResult`が1メッセージからrefs集約。制約：MAX_IMAGES=8、maxImageBytes上限、walkは深さ4/20000ファイル、隠しディレクトリとnode_modules除外 |
| `src/dedup.ts` | `SeenTracker`。キー＝**画像内容SHA-256**（パスではない→同パスでも内容が変われば再投入＝Blender再レンダ対応）。`<wd>/.vision-bridge/state.json`に永続化（Generatorがprediction毎に新生しても効く）。hashCache付き |
| `src/vision-bridge.ts` | Phase 3統合 `applyVisionBridge({ctl,messages,cfg,seen}) → {messages,injected,skippedDuplicates,workingDirectory}`。**全**toolメッセージからrefs収集→解決→**エンコード→register**（この順序はバグ修正後で維持）→新画像≥1なら **1つの**synthetic user message（注記テキスト+1〜N個の`image_url` data URL）を**最後のtoolメッセージの直後**に**送信コピーだけ**へ挿入。`requoteOriginalRequest`（既定true）なら直前のuserリクエストを逐語引用した注記になる（`findOriginalPendingRequest`）。全重複/テキストMCPは履歴無変更で推論 |
| `src/controller.ts` | **レガシーSDKアダプタ（旧beta host表面のprobe集約）**。現行hostでは `src/index.ts` が新API（`toolCallGeneration*`）を使うため、こちは**フォールバック経路**。`getWorkingDirectory`（`getWorkingDirectory()`/snake/プロパティ順probe）、`getControllerTools`、`getModelInfo`、`reportToolCall`（`REPORT_METHODS`＝report_tool_call/reportToolCall/emit_*/notify_*/request_tool_call × {id,tool,args}とOpenAI風ペイロードの順に試行、成功経路をログ。全失敗時`availableKeys`をログに吐く→**ここで実メソッド名を追記する**） |
| `src/config.ts` | 優先度：環境変数 > `<wd>/.vision-bridge/config.json` > `~/.vision-bridge/config.json` > 既定。キー：`apiRoot`(**http://127.0.0.1:1238**) / `apiKey`(lm-studio) / `model`(**qwen/qwen3.8-27b**＝作者環境用・別環境ではconfig/envで要上書き) / `timeoutMs`(300000) / `maxImageBytes`(20MB) / `logLevel`(info) / `logFile`(`<wd>/.vision-bridge.log`) / `bridgeEnabled`(true) / `syntheticText` / `requoteOriginalRequest`(**true**) |
| `src/log.ts` | levelゲート+appendファイル+**base64 redact**（160文字以上の連続→`<redacted-b64:Nb>`、文字列800字超は`<string:N chars>`） |
| `src/types.ts` | 共有型+`BridgeError(code)` |

| `build/` | **tsc出力ミラー＝ハーネストestの実行対象**（`build/index.js`+`build/src/*.js`）。**`src/*.ts`を編集したら `npm run build`（ルート、または `cd vision-bridge && npm run build`）で必ず再生成**。**現状 `requoteOriginalRequest` が未同期（src/とdev.jsにのみ存在）** |
| `.lmstudio/entry.ts` | **hostブートストラップ**（`lms dev`が生成）。`@lmstudio/sdk` のself-registration host経由で `../src/index.ts` の `main(pluginContext)` を呼ぶ。プラグイン登録時はこのエントリが効く |
| `.lmstudio/dev.js` | `lms dev` 用のバンドル（esbuild CJS・`--packages=external`）。現行srcを含む最新状態 |
| `package.json` / `tsconfig.json` / `package-lock.json` | 依存 `@lmstudio/sdk 1.4.0`・devDeps `typescript`／rootDir `.` → outDir `build`／lockfileで再現可能 |
| `node_modules/` | **導入済み**（typescript・@lmstudio/sdk・@types/node 等）＝`npm run build` 可能 |
| `types/lmstudio.d.ts` | 旧beta SDK（`"lmstudio"`モジュール）のambient型。参考用（現行hostは `@lmstudio/sdk`） |

### `scripts/harness/`（テスト基盤）
| ファイル | 职责 |
|---|---|
| `mock-lmstudio.mjs` | `BaseController`モック（`getWorkingDirectory`/`report_tool_call`捕捉=`reportedToolCalls`配列/`tools`/`get_model_info`）+`Generator`基底 |
| `loader-hooks.mjs` + `register-mock.mjs` | Node module hooksで`"lmstudio"`→モック解決。テストファイル側でも自登録している（`--import`なし直接実行でも動く） |
| `fixture-image.mjs` | 依存ゼロPNG生成。既定＝左red/右blue。**2番目引数`pixels`で別内容PNGを生成可能**（重複排除テストは内容hashで判定するため必須） |
| `mock-api.mjs` | in-processモックOpenAI API（既定127.0.0.1:18999）。SSEストリーミング返却。mode判定：履歴にtoolメッセージ→`after-tool`／toolsあり→tool call `mock_tool {"x":1}` をSSEで返却／それ以外→`BRIDGE-OK`。**`data:image/` data URLを1つでも見かけたら**`MOCK-VISION-OK: I see N image(s)`。`state.requests`で要求内容を検証可能 |
| `api-smoke.mjs` | Phase 0：`GET /v1/models` 疎通＋Qwen有無 |
| `phase1-text-test.mjs` | A:テキスト折り返し B:tool callが`report_tool_call`で報告される C:assistant toolCallRequest+tool resultの履歴がラウンドトリップ（`--mock`で全hard） |
| `phase1-vision-test.mjs` | シナリオ1:手動添付相当（user file part→data URL→Qwen）。シナリオ2:MCP相当（tool resultに`fileName:`+markdown→bridge注入→Qwen）。入力履歴不変もassert |
| `phase2-detect-test.mjs` | 9ケース：markdown/fileName:/URLエンコード/フリーテキスト(語 swallow対策)/複数画像/非画像/無参照/解決不能（＝最新画像fallbackしない）/file part |
| `phase3-bridge-test.mjs` | 1:注入（1つのsynthetic message、data URL付き）2:重複スキップ 3:新画像だけ投入 4:テキストMCPは無変更 5:複数画像→1メッセージ・複数part |

### `proxy/`
| ファイル | 职责 |
|---|---|
| `fallback-proxy.mjs` | **第二候補のみ**。18080待ち受け→`PROXY_TARGET`(既定18081)へ転送。SSEはpipe。MCP実行は元のLM Studioに残す |
| `README.md` | 起動方法・config差し替え手順 |

## 5. 不変条件（壊さないこと・優先順位）

1. **既存MCPを壊さない**：GeneratorはMCPを絶対実行しない。tool callは必ず`reportToolCall(ctl)`で報告して停止。
2. **toolメッセージに画像を付けない**（LM Studio SDKの型制約）→ synthetic user message方式のみ。
3. **UIの永続履歴に触れない**：加工は「Qwenへ送るコピー」だけ。入力行列はmutateしない（テストがassert）。
4. **重複排除は内容hash**：同パス＋別内容＝再投入、同内容＝スキップ（ログ`DUPLICATE image skipped`）。
5. **エンコード成功してからregister**（この順序を逆にしてはいけない＝修正済みバグの回帰）。
6. **「フォルダ内最新画像の無条件選択」は禁止**（全解決はtool resultの参照駆動）。
7. 画像0件のMCPツールは履歴無変更で従来通り推論。
8. `src/*.ts` と `build/*.js` は常に同期（**2026-07-09時点では未同期：`requoteOriginalRequest`。`npm run build` で解消**）。
9. 責務分離：`LM Studio(MCP実行) ↔ Generator(推論ラップ+bridge)` の境界を越えない。

## 6. デバッグ時に要る実装詳細

- API失敗時、generatorは `⚠️ Vision Bridge: <msg>` をhostへyieldする（テストは`⚠️`前置で検出）。
- ログ必見行：`invocation ... started` / `image reference(s) detected` / `image candidate adopted` /
  `VISION MESSAGE INJECTED` / `DUPLICATE image skipped` / `api_queued (HTTP 202)` / `no working tool-call reporting method found`。
- `no working tool-call reporting method found` が出たら→ログの`availableKeys`を見て
  `src/controller.ts` の `REPORT_METHODS` 配列に実メソッド名を1行追加（+build同期）。
- 「no tool definitions found」→ hostがtoolsをどこに載せるか（generate追加引数 vs `ctl.tools`）を
  `getModelInfo`ログや`availableKeys`で確認し、`generator.ts` の取得順 or `controller.ts` の候補に追加。
- 画像が検出されない→ログ`values`を見て `src/image-detect.ts` のregex（MD_IMAGE_RE / FILE_NAME_RE / GENERIC_PATH_RE）へ
  実tool resultの表現を追加（+build同期）。
- 手動添付のuser file partは実hostの形状未確認→`messages.ts::partImagePart`が
  `path/file_path/filePath/url/file_name/fileName/name/src`＋`data:` URLを順に試す設計（実機で失敗したらここで候補追加）。
- ポート整理：実API `1238`／モックAPI `18999`／プロキシ `18080`→`18081`。
- 生成物の配置：ログ `<wd>/.vision-bridge.log`、state `<wd>/.vision-bridge/state.json`、設定 `<wd>/.vision-bridge/config.json`（`.gitignore`済み）。

## 7. 今セッションで修正したバグ（回退させない）

1. `vision-bridge/src/vision-bridge.ts`（+build）：**画像を「既投入済み」登録してからエンコードしていた**→
   読み込み失敗すると以降永久スキップ。修正：`fileToDataUrl`成功後に`registerIfNew`。
2. `vision-bridge/src/image-detect.ts`（+build）：フリーテキストパス抽出が前置語までcapture
   （"As you can see in my shot.png"）して解決不能→**後方サフィックス再試行**（path-token・空白含む時のみ、
   長い順に "my shot.png" へ絞る）を追加。phase2-detect のケース4がこれを検証。
3. `vision-bridge/src/messages.ts`（+build）：`toOpenAIMessage`が抽出テキストなしの
   user/system/assistant message（画像のみ添付でテキスト空、空system prompt、空テキストのassistant
   tool-call message）に **`content: null`** を送出していた→`typeof null === "object"`のため
   LM Studio 400 `Messages from roles [user, system, tool] must contain a 'content' field. Got 'object'.`
   修正：contentは常にstring（公式`toOpenAIMessages()`は`message.getText()`＝常にstring）。新設
   `normalizeOpenAIMessage(s)`/`describeMessageShape`が送信点（`openai-client.ts`）で公式型を
   強制（raw objectは転送せずtext抽出、userのみtext/image_url配列可）。送信直前ログ
   `outgoing message shapes (pre-send)`（index/role/typeof content/Array.isArray/part types、
   base64はredact）で違反messageをindex特定可能。新テスト`npm run phase1:messages`＋
   phase1:sdkchatシナリオ8（空contentがワイヤ上string/arrayのみ）。Vision検出・dedup・
   synthetic message・MCP処理は不変。

## 8. 未確認事項・リスク（実機で潰すもの）

1. ~~【最大】UI内折り返しの並列性~~ → **作者環境で成立を確認済み**（2026-07）。
   別環境（別LM Studioバージョン等）で `api_queued (202)` / `api_error 503` / `api_timeout`
   が出たらフォールバックプロキシ（`proxy/fallback-proxy.mjs`）を使う。
2. **実host SDK表面**：現行API（`withGenerator` / `fragmentGenerated` / `toolCallGeneration*` / SDK `Chat`）で
   作者環境確認済み。別バージョンのhostで形状がズレたら、`src/index.ts` の新API経路と
   `src/controller.ts` のレガシーprobeの両方を確認する。
3. **`build/` と `src/` の未同期**（`requoteOriginalRequest`）：ハーネスは旧挙動をテストしている。
   `npm run build` 後にハーネス全実行が緑になることを確認する（requoteはsynthetic messageのテキスト形状を変えるのみで、
   既存アサーションは互換性の想定）。※未検証。
4. Qwen3.8-27BのVision経路でのdata URL相性＝作者環境で確認済み（基本動作）。別モデルでは
   phase1:vision実機で再判定（手動添付経路がコントロール）。
5. **第三者引き渡しの落とし穴**：`model` 既定値が作者環境用（`qwen/qwen3.8-27b`）・`apiRoot` 既定が1238。
   受け手は `config.json`（`<wd>/.vision-bridge/config.json` または `~/.vision-bridge/config.json`）
   か環境変数で上書きする必要がある（README「モデル名・API先を変える場所」）。また
   `.gitignore` が `node_modules/`・`.lmstudio/` を除外するため、**git渡しは不可・zip渡しを推奨**。
6. **LM Studioバージョン依存**：プラグインホスト（SDK 1.4.0系）のない古いバージョンでは登録しても生成できない。
   受け手には「プラグイン機能のある同じ世代のバージョン」を伝える。

## 9. やらないこと（要件指定の境界）

MCPクライアント再実装／Blender専用実装／UIマウス操作・自動クリック／クリップボード経由画像／
常時フォルダ監視でタイミング推測／LM Studio内部ファイル改造／tool resultの型制約を破る画像付加／巨大フレームワーク導入。

## 10. 環境

- Windows、作業ディレクトリ `F:\AI\MCP_qwen3.8`（許可ディレクトリはここのみ）
- **Node.js 20.6+**（ハーネスのみ。`--import` hooks使用。Node 18系なら`--experimental-loader`に差し替え：TESTING.md冒頭）
- LM Studio：プラグイン機能のあるバージョン、ローカルサーバー `127.0.0.1:1238`（Bearer `lm-studio`）、Qwen3.8-27B（Vision対応）ロード済み
- MCP側：Blender MCP（他MCPのImageContent返却にも通用する設計）
- `vision-bridge/node_modules` **導入済み**（typescript・@lmstudio/sdk 1.4.0）＝`npm run build` 可
- 公式エントリ：`.lmstudio/entry.ts` → `src/index.ts`（`main(context)`）。hostは現行プラグインAPI（`withGenerator`等）

---
*（このSTATUS.mdは「次のAIが§3だけ読んで動ける」ことを目的にしたスナップショット。2026-07-09に現状（現行host API移行・node_modules導入・作者環境動作確認・build/未同期）へ更新。）*
