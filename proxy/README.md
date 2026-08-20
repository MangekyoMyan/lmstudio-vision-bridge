# Fallback Proxy（第二候補）

> **通常の運用では使わない**。Generator → 同じLM Studioのlocalhost API への折り返しが
> 並列で成立しない場合（ログに `api_queued (HTTP 202)` / `api_error 503` / `api_timeout`）
> のみ使用する「薄いLLMプロキシ」です。

## 設計思想

- **MCP実行は元のLM Studioに残す**（責務分離は維持する）
- 折り返し先（推論ターゲット）だけを「別プロセス/別インスタンス」へ外す
- Generator → `fallback-proxy` (18080) → 第二推論先 (18081 等) のみ変わる

## 用意するもの

第二の推論先を1つ:

- 別ポートで起動した第二LM Studioインスタンス（Qwen3.8-27Bをロード）
- `lms serve` 等による別サーバ

## 起動

```powershell
$env:PROXY_TARGET = "http://127.0.0.1:18081"  # 第二推論先
$env:PROXY_PORT   = "18080"                    # 既定
node proxy\fallback-proxy.mjs
```

## Generatorをプロキシに向ける

 predictionのworking directoryに設定ファイルを作成:

```
<working directory>/.vision-bridge/config.json
```

```json
{ "apiRoot": "http://127.0.0.1:18080" }
```

または環境変数 `VISION_BRIDGE_API_ROOT=http://127.0.0.1:18080`。

以降、MCPループ（tool call → LM Studioが実行 → 再呼出 → Vision Bridge → 推論）は
そのまま動作し、推論だけが第二推論先で行われる。

## 注意

- ストリーミング(SSE)はそのままパイプされる
- `PROXY_TARGET_API_KEY` で第二推論先のBearerキーを差し替えられる（既定は同じキーを流用）
- UI自動操作・MCPクライアントの再実装は **このフォールバックでもやらない**
