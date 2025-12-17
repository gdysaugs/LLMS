# 現状メモ (2025-12-16)

## 構成
- フロント: Cloudflare Pages プロジェクト `llms`  
  - 最新プレビュー: https://048aad20.llms-3yk.pages.dev （以降の微修正デプロイ: https://0844641d.llms-3yk.pages.dev, https://891bc3d8.llms-3yk.pages.dev）
- バックエンド:
  - Llama (RunPod serverless): `suarez123/llama-worker:20251217-gpu-q6-ctx12288`（CUDA12.2ビルド、CMAKE_CUDA_ARCHITECTURES=70/75/80/86/89/90、起動時GPUヘルスチェック付き、CTX=12288, LLAMA_MAX_TOKENS=3500, モデル Berghof-NSFW-7B.i1-Q6_K.gguf, REQUIRE_GPU=1デフォルト）
  - 旧タグ: `20251216-gpu-q6-ctx12288`（CUDA12.4ベース） / `20251215-gpu-q6-ctx8192`（CTX=8192, MAX=2500）
  - SoVITS: `suarez123/sovits-serverless:hscene-20251215o`（ffmpegポストなし、デフォルトprompt_textは空→"んっ！"に強制、ref-free許可）
  - FaceFusion/Presign API: `suarez123/facefusion-api:20251214-ticket-auth`
  - Gateway (Workers): `api-gateway.adamadams567890.workers.dev` （/run-llama, /run-sovits, /r2-proxy などをCORS付きでプロキシ）
- ストレージ: Cloudflare R2（アップロード/生成結果保存）。  
- 認証/課金: Supabase Auth + Stripe（チケット必須、失敗時は自動リファンド）。

## フロントの挙動（Generate）
- キャラ設定 → LLM台本生成 → 参照音声プリセット選択 → SoVITS合成までを1画面で実行。ユーザーアップロードは禁止。
- 台本生成:
  - 段落スライダー最大200行、max_tokensは段落数に応じて最大3500（backend MAX=3500に合わせる）。
  - プロンプトはセリフのみ・モノローグ・数字禁止・括弧/効果音/メタ終端禁止。行頭の数字はフロントで自動除去。
  - LLMリクエストは `{input: {...}}` 形式。非同期ジョブIDが返った場合は `/run-llama/status/{id}` をポーリング（~10分）。
  - タイムアウトは10分。
- 参照音声:
  - R2に事前配置したプリセットキーから選択（ref-free想定）。アップロードUIなし。
- SoVITS合成:
  - 固定オプション（ja/ja, speed=1.2, temperature=1.0, top_p=1.0, sample_steps=8, prosody off, cut=punctuation）。
  - ステータスURLがあればポーリング。出力URLをオーディオタグで再生。
  - ffmpegポストエフェクトは入れていない（生WAVを返す）。
  - フロント側のASMR加工も無し（Web Audio FXを撤去済み）。
- 認可: Supabaseセッション必須。SoVITS実行時に `/tickets/consume` でチケット1枚必須。
- ログ: LLM/SoVITS進行をログに表示。

## API / Gateway
- `/storage/presign`（FastAPI経由）: intent=upload/get, expires_in=900。Authorization: Bearer <FF_API_SECRET>, X-Api-Key 同値。
- `/run-llama` / `/run-llama/status/{id}`: RunPod Llama をプロキシ。
- `/run-sovits` / `/run-sovits/status/{id}`: RunPod SoVITS をプロキシ。
- `/r2-proxy`: R2オブジェクトをCORS付きで中継。

## 環境変数（Pages）
- VITE_API_BASE_URL=https://api.lipdiffusion.uk/fastapi
- VITE_API_GATEWAY_BASE_URL=https://api-gateway.adamadams567890.workers.dev
- VITE_API_KEY=<FF_API_SECRET と同じサービスキー>  ※Preview/Production両方に設定。ローカルビルド時もexportが必要。
- VITE_LLM_MODEL_PATH=/opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf
- VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY （認証を使う場合）
- VITE_LLM_API_URL / VITE_SOVITS_RUN_URL / VITE_SOVITS_STATUS_URL は未設定なら gateway 経由を自動利用。

## セキュリティ/運用
- LLM/SoVITSへの直接呼び出しはすべて gateway 経由（CORS許可）。CF Access/共有キーで保護。
- R2は presign 経由。ファイル再生は /r2-proxy でCORS/Range対策。
- Cloudflare レート制限: /run /status /storage /generate /r2-proxy 等に設定推奨。
- Pages 25MB制限は回避不可。大きいプリセットはR2へ。

## デプロイ（WSLでローカルビルドする場合）
```bash
export VITE_API_BASE_URL=https://api.lipdiffusion.uk/fastapi
export VITE_API_KEY=<FF_API_SECRETと同じ値>
# 必要なら VITE_API_GATEWAY_BASE_URL なども export
npm run build
npx wrangler pages deploy dist --project-name llms --commit-dirty=true
```

## 既知の注意点
- 12288 ctx / max_tokens 3500 はVRAM16GBギリギリ。長文は分割生成が安全。
- モデルはリスト癖があるため、番号禁止を明記しつつフロントで行頭数字を自動剥がし。完全に抑止できない場合はさらにトークン上限を上げるか分割生成で対応。
- llama-worker は起動時に nvidia-smi / libcuda をチェック（REQUIRE_GPU=1デフォルト）。ローカルCPUで動かす場合は REQUIRE_GPU=0 でスキップ可能だが性能低下。N_BATCH/MAIN_GPU も env で上書き可。
