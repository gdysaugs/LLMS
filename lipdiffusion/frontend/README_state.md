# 現状メモ (2025-12-13)

## 全体構成
- フロント: /home/adama/LLMS/lipdiffusion/frontend (Cloudflare Pages プロジェクト名: llms, デプロイ先例 https://llms-3yk.pages.dev / https://app.lipdiffusion.uk).
- バックエンド: FastAPI (RunPod 等) エンドポイント例 https://api.lipdiffusion.uk/fastapi。利用イメージ例: suarez123/facefusion-api:20251213-transcode2。
- ストレージ: Cloudflare R2 (生成結果や中間ファイル保存)。

## 主な API
- POST /fastapi/transcode-preview  
  入力: ideo (multipart), 	rim_start, 	rim_end。  
  出力: public_url / presigned_url, duration。プレビュー用に H.264/AAC へ変換。

- POST /fastapi/generate  
  入力: ideo, 	rim_start, 	rim_end, udio_candidate_start, udio_candidate_end, script_text(任意), 必要に応じて Authorization: Bearer <API_KEY>。  
  出力: 直接 output.public_url 等、または 	ask / 	ask_id。

- GET /fastapi/status/{task_id}?wait=true  
  タスク完了待ちと結果取得。

## フロント想定 UX (実装が壊れているため未完)
1) 動画選択 → /transcode-preview で H.264/AAC へ変換。  
2) 返却 URL を一度 GET して blob に変換し、ローカル objectURL でプレビュー/トリム (R2 直再生しない)。  
3) 動画トリムと音声トリムを同じ動画で指定 (開始・終了バー)。範囲のみ再生確認。  
4) セリフ入力欄あり。  
5) /generate へ送信。public_url で即取得、または status ポーリングで結果取得。  
6) プレビュー時は R2 直再生を避ける。

## デプロイ手順 (WSL 内)

> frontend@0.0.0 build
> tsc -b && vite build

src/pages/Generate.tsx(1,61): error TS1002: Unterminated string literal.

 ⛅️ wrangler 4.53.0 (update available 4.54.0)
─────────────────────────────────────────────
Uploading... (18/18)
✨ Success! Uploaded 0 files (18 already uploaded) (1.20 sec)

🌎 Deploying...
✨ Deployment complete! Take a peek over at https://7156c8fc.llms-3yk.pages.dev
※ 未コミット警告は --commit-dirty=true で抑止可能。

## Pages 環境変数例
- VITE_API_BASE_URL=https://api.lipdiffusion.uk/fastapi
- VITE_API_KEY=<任意のキー>

## 既知の問題
- H.265/HEVC 動画はプレビューで黒画面になりがち → プレビューはサーバーで H.264/AAC へ変換必須。  
- R2 の public_url を直接 video に渡すと 400/黒画面が出るケースあり → 一度 GET→blob→objectURL で回避。  
- モバイルで音声トリム失敗報告あり (未調査)。  
- 生成結果が無音になるケースあり (トリム音声の受け渡し不整合疑い)。

## 更新ログ (2025-12-13)
- src/pages/Generate.tsx を全面再実装 (動画/音声アップロード + トリム、/transcode-preview で H.264 プレビュー化、/generate 送信＋/status ポーリング、R2 blob 再生)。
- npm run build 成功。
- wrangler pages deploy dist --project-name llms --commit-dirty=true → https://a5e1b38c.llms-3yk.pages.dev
- api-gateway: /r2-proxy を追加 (R2 presigned URL を CORS 付きでプロキシ)。wrangler deploy 済み。
- 生成画面をシンプル化（トリム・音声候補なし、動画/音声アップ＋ファイル名表示のみ、日本語 UI、生成ボタンで /generate 送信＆結果 Blob 再生）。
