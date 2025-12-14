# 現状メモ (2025-12-14)

## 構成
- フロント: 
  - Cloudflare Pages プロジェクト名: 
  - 直近デプロイ例: , , 
- バックエンド (FastAPI on RunPod 等): 
  - SoVITS: 
  - Wav2Lip: 
  - FaceFusion/Presign API:  など
- ストレージ: Cloudflare R2（アップロード/生成結果を保存）。Pagesの静的上限25MBを超えるファイルはR2等に置く。
- 認証/課金: Supabase Auth + Stripe。ログイン必須、生成ごとにチケット1枚消費（失敗時自動払い戻し）。

## フロントの挙動
### Generate ページ
- 動画/音声アップロード、セリフ入力。サンプル音声/動画はトグルで表示（デフォルト非表示）、動画はページ内で即再生可。
- SoVITS設定: speedデフォルト1.3（UI 1.3〜2.0）、temperature 1.0。セリフは「？」以外の記号を「。」に正規化。
- プリセット音声: 少年系(23980)、かわいい女の子、お姉さん、高音/低音女性、鳴き声＆喘ぎ声、元気な女の子、メスガキ。
- プリセット動画: sample_video_1/2/3（無音、25MB以下に調整）。
- 進行ログ: 音声合成完了/口パク生成完了を結果から検出して追記。
- 結果動画は gateway  経由で取得→Blob再生（CORS/Range回避）。

### Trim ページ
- 動画を読み込むと音声のみ抽出し波形トリム（動画トリムなし）。ffmpeg.wasmで抽出＋ノイズ除去（highpass/lowpass/afftdn/acompressor）。
- ズーム機能は廃止し、波形を常に画面幅にフィットさせ、横はみ出し・ガタつきを抑制。

## API（主要）
- POST  : R2署名付きURL取得（intent=upload、expires_in=900）。
- POST  : 生成ジョブ開始（返り値 task_id または output_url）。
- GET   : ジョブ状態/結果取得。
- POST  /  : チケット操作。
- POST  : プレビュー用H.264変換（現在フロントでは未使用）。

## 環境変数（Pages例）
- VITE_API_BASE_URL=https://api.lipdiffusion.uk/fastapi
- VITE_API_GATEWAY_BASE_URL=https://api-gateway.adamadams567890.workers.dev
- VITE_API_KEY=<サービスキー>
- VITE_TICKET_TOKEN=<チケット用シークレット>
- VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY

## セキュリティ/運用
- ログイン必須＋チケット必須。未ログイン/残高不足はエラー。
- R2への直接再生は避け、gateway  経由でCORS/Range対策。
- Cloudflareで /run /status /storage /generate /r2-proxy 等にレート制限（例: 10秒30リクエスト）を設定。
- セリフの記号正規化で異常文字によるエラーを低減。
- Pages 25MB制限は変更不可。大容量プリセットはR2等に置くこと。

## デプロイ（WSL）

> frontend@0.0.0 build
> tsc -b && vite build

vite v7.2.2 building client environment for production...
transforming...
✓ 128 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.46 kB │ gzip:   0.29 kB
dist/assets/worker-BAOIWoxA.js    2.53 kB
dist/assets/index-B-FBcpF7.css   10.64 kB │ gzip:   2.85 kB
dist/assets/index-C8BB1kci.js   490.85 kB │ gzip: 144.81 kB
✓ built in 1.64s

 ⛅️ wrangler 4.53.0 (update available 4.54.0)
─────────────────────────────────────────────
Uploading... (30/30)
✨ Success! Uploaded 0 files (30 already uploaded) (0.31 sec)

✨ Uploading _headers
✨ Uploading _redirects
🌎 Deploying...
✨ Deployment complete! Take a peek over at https://26a52257.llms-3yk.pages.dev

## 既知の制約
- H.265/HEVCはブラウザ再生で黒画面になりやすい → H.264推奨。
- SoVITSは参照音声をWAV(PCM)で渡すのが安全。MP3/M4Aのみだとデコード失敗例あり。
- Pagesの25MB上限は回避不可。外部ストレージ利用で対応。
