# 現状メモ (2025-12-20)

## 構成
- フロント: Cloudflare Pages プロジェクト `llms`
  - 最新デプロイ: https://48d40050.llms-3yk.pages.dev
- バックエンド/ゲートウェイ:
  - API Gateway (Workers): `https://api-gateway.adamadams567890.workers.dev`（/run-llama, /run-sovits, /r2-proxy などをプロキシ）
  - FastAPI (backend): `https://api.lipdiffusion.uk/fastapi`（gateway直指定も可）
  - Llama worker: suarez123/llama-worker（Berghof-NSFW-7B.i1-Q6_K.gguf, ctx=12288, max_tokens=3500）
  - SoVITS: suarez123/sovits-serverless:hscene-20251215n（フロントから speed=1.0, top_p=1.0, temp=1.0, sample_steps=8, prosody off, cut=punctuation を送信）
  - R2: 固定バケット llm / オブジェクト `sampleaudio/hello2.mp3` を参照音声として使用（アップロード不要）。

## フロント挙動（Generate.tsx 現行）
- 画面フロー: キャラ設定 → 台本生成（LLM） → 参照音声（固定） → SoVITS 合成。
- キャラプリセット（2人）
  - 陽菜: 優しくてシャイな後輩。柔らかい囁き口調。
  - リオン: 強気で口調が荒い同級生。テンポ速め。
- シーンプリセット: 学校（放課後教室でエッチ） / 自宅（自宅でエッチ）。
- 行動プリセット: レイプ（無理やり犯される） / フェラ（擬音付き） / 中だし。最大3つまでチェック可。
- リスナー名: UIで自由入力。プロンプト内で「必ずリスナーを『入力名』で呼ぶ」指示を付与。
- プロンプト生成:
  - `user_input` のみ送信（promptは空）。キャラ設定・シーン・行動ヒント・リスナー名を列挙し、モノローグ500文字以上、相手セリフ禁止、記号/括弧禁止を明記。
  - max_tokens は段落スライダーに応じて自動設定（min800, max3500）。
- 参照音声: 常に固定キー `sampleaudio/hello2.mp3` を使う。アップロードUIは任意だが送信は固定キー。
- SoVITS送信オプション: ja/ja, speed=1.0, temp=1.0, top_p=1.0, sample_steps=8, pause=0.4, prosody off, cut=punctuation, ref_free=true。出力は同期レスポンスまたはステータスで取得し、audioタグ再生。
- ログ: LLM/SoVITS の進行を画面下部に表示。

## APIエンドポイント
- /run-llama /run-llama/status/{id}（gatewayまたは fastapi）
- /run-sovits /run-sovits/status/{id}（gatewayまたは fastapi）
- /r2-proxy （R2オブジェクト中継, CORS付き）

## Pages 環境変数（想定）
- VITE_API_BASE_URL=https://api.lipdiffusion.uk/fastapi
- VITE_API_GATEWAY_BASE_URL=https://api-gateway.adamadams567890.workers.dev
- VITE_API_KEY=（FF_API_SECRET と同値のサービスキー）
- VITE_LLM_MODEL_PATH=/opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf

## デプロイ手順（WSL）
```
cd /home/adama/LLMS/lipdiffusion/frontend
npm run build
npx wrangler pages deploy dist --project-name llms --commit-dirty=true
```

## メモ
- Llamaは番号・会話化を抑止する指示を入れているが、完全抑止はモデル依存。必要ならプロンプトを追加調整。
- ctx=12288/max_tokens=3500想定。長文は分割生成が安全。
