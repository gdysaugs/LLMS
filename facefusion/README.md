# FaceFusion サーバーレス構成ガイド（RunPod 版）

このリポジトリは、オリジナルの FaceFusion を RunPod Serverless と常駐 CPU ポッドを組み合わせたパイプラインとして再構成したものです。Wav2Lip / FaceFusion の推論は全て Serverless へオフロードし、常駐側では FastAPI によるオーケストレーションと Gradio UI のみを維持します。

---

## アーキテクチャ概要

- **FastAPI（CPU ポッド）**  
  - エンドポイント: `/run`, `/status/{task_id}`, `/storage/*`  
  - 役割: RunPod へのジョブ投入 / ステータス監視、Cloudflare R2 へのアップロード、Upstash Redis によるジョブ記録  
  - イメージ: `suarez123/facefusion-api:20251020-3`

- **RunPod Serverless**
  - **Wav2Lip**: `suarez123/wav2lip-serverless:20251020-3`  
    音声駆動のリップシンク動画を生成し、生成結果を R2 に保存
  - **FaceFusion**: `suarez123/facefusion-serverless:20251020-3`  
    必要に応じて Wav2Lip の結果を取り込み、フェイススワップ済み動画を生成

- **Gradio フロントエンド（CPU ポッド）**  
  - ユーザー UI（音声 / 動画 / 画像をアップロードし結果を表示）  
  - イメージ: `suarez123/facefusion-gradio:20251020-5`

- **ストレージ**: Cloudflare R2（推論入力/出力）  
- **ジョブストア**: Upstash Redis（`rediss://` 接続）

---

## 必要要件

| カテゴリ | 内容 |
| --- | --- |
| RunPod | Serverless エンドポイント 2 個（Wav2Lip, FaceFusion）、常駐 CPU ポッド（FastAPI + Gradio） |
| ストレージ | Cloudflare R2 バケット（Put/Get 権限） |
| ジョブ管理 | TLS 対応 Redis（Upstash を推奨） |
| その他 | Docker CLI、RunPod API Key、Cloudflare API Key |

---

## コンテナイメージとビルド

```bash
# FastAPI（CPU ポッド）
docker build -t suarez123/facefusion-api:20251020-3 -f Dockerfile.api .

# Wav2Lip Serverless
docker build -t suarez123/wav2lip-serverless:20251020-3 \
  -f runpod-facefusion/Dockerfile.serverless.wav2lip .

# FaceFusion Serverless
docker build -t suarez123/facefusion-serverless:20251020-3 \
  -f runpod-facefusion/Dockerfile.serverless.facefusion .

# Gradio UI
docker build -t suarez123/facefusion-gradio:20251020-5 -f Dockerfile.gradio .

# Docker Hub へプッシュ（例）
docker push suarez123/facefusion-api:20251020-3
docker push suarez123/wav2lip-serverless:20251020-3
docker push suarez123/facefusion-serverless:20251020-3
docker push suarez123/facefusion-gradio:20251020-5
```

タグは運用に合わせて変更してください（`YYYYMMDD-n` 形式を推奨）。

---

## 環境変数一覧

| 変数 | FastAPI | Serverless | Gradio | 説明 |
| --- | :---: | :---: | :---: | --- |
| `RUNPOD_API_KEY` | ✓ | ✓ |  | RunPod API Key |
| `RUNPOD_WAV2LIP_ENDPOINT` | ✓ |  |  | Wav2Lip Endpoint ID |
| `RUNPOD_FACEFUSION_ENDPOINT` | ✓ |  |  | FaceFusion Endpoint ID |
| `RUNPOD_API_BASE` | ✓ | ✓ |  | API ベース URL（既定 `https://api.runpod.ai/v2`） |
| `R2_ENDPOINT` / `R2_BUCKET` | ✓ | ✓ | ✓ | Cloudflare R2 接続情報 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | ✓ | ✓ | ✓ | Cloudflare API Key |
| `R2_REGION` | ✓ | ✓ | ✓ | R2 リージョン（通常 `auto`） |
| `R2_PUBLIC_BASE_URL` | ✓ | ✓ | ✓ | 公開 CDN ベース URL（任意） |
| `R2_PRESIGN_EXPIRY` | ✓ | ✓ | ✓ | 署名 URL の TTL（秒） |
| `JOBSTORE_REDIS_URL` | ✓ |  |  | Upstash Redis（`rediss://`） |
| `JOBSTORE_PREFIX` | ✓ |  |  | ジョブキー prefix（既定 `ff:task`） |
| `JOBSTORE_TTL` | ✓ |  |  | ジョブ保存期間（秒） |
| `FF_API_BASE_URL` |  |  | ✓ | Gradio から FastAPI への接続先 |
| `FF_POLL_INTERVAL` / `FF_POLL_TIMEOUT` |  |  | ✓ | Gradio のジョブポーリング設定 |

Serverless 側には FastAPI と同じ R2/RunPod 変数を渡してください。FaceFusion endpoint には Wav2Lip の出力を渡すため `retain_intermediate=true` がデフォルトです。

---

## デプロイ手順

### 1. FastAPI（CPU ポッド）

```bash
docker run -d --name facefusion-api \
  -p 8000:8000 \
  --env-file fastapi.env \
  suarez123/facefusion-api:20251020-3
```

`fastapi.env` には Redis / R2 / RunPod の各変数を定義します。ヘルスチェックは `GET /health` を使用してください。

### 2. RunPod Serverless

1. RunPod Dashboard で **Wav2Lip** エンドポイントを作成し、イメージとして `suarez123/wav2lip-serverless:20251020-3` を指定。環境変数には R2 情報をセット。  
2. 同様に **FaceFusion** エンドポイントを作成（イメージ `suarez123/facefusion-serverless:20251020-3`）。Wav2Lip の出力を受け取るため、`retain_intermediate` を `true` にするか、FastAPI 側のデフォルト設定を利用します。  
3. FastAPI の環境変数 `RUNPOD_WAV2LIP_ENDPOINT` / `RUNPOD_FACEFUSION_ENDPOINT` にそれぞれの Endpoint ID を設定。

### 3. Gradio フロントエンド

```bash
docker run -d --name facefusion-gradio \
  -p 7860:7860 \
  --env-file gradio.env \
  suarez123/facefusion-gradio:20251020-5
```

`gradio.env` には R2 情報と `FF_API_BASE_URL`（例: `https://<api-pod>.proxy.runpod.net`）を設定します。

---

## API の利用方法

### `/run`（POST）
`PipelineRequest` JSON を受け取り、RunPod ジョブを組み立てます。

例:
```json
{
  "audio_key": "uploads/audio/sample.wav",
  "target_key": "uploads/video/target.mp4",
  "source_keys": ["uploads/source/face.png"],
  "retain_intermediate": true
}
```

- `wait=true` を付けると完了まで同期待機します。  
- 戻り値には `task_id`, `status`, `stage` が含まれます。

### `/status/{task_id}`（GET）
ジョブの全履歴を返します。`wait=true` で完了までブロック可能です。

主なステータス遷移: `pending → running → completed / failed`  
進行状況は `progress` フィールドで確認できます。

---

## Gradio UI の使い方

1. ブラウザで `http://<host>:7860` にアクセス。  
2. 音声（必須）とターゲット動画（必須）をアップロード。  
3. 顔置換を行う場合はソース画像を 1 枚以上追加。  
4. 「Run Pipeline」を押下。  
5. ステータス欄に `Job COMPLETED` が表示されたら、動画プレビューとダウンロードリンクが有効になります。

Wav2Lip のみ実行する場合はソース画像を省略してください。FaceFusion を実行する際は、推論時間短縮のため高解像度動画を事前にクロップしておくと安定します。

---

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| `/run` が 503 を返す | RunPod API Key または Endpoint ID が未設定、もしくは Serverless 側が停止しています。FastAPI 環境変数と RunPod ダッシュボードを確認。 |
| Gradio が `Job RUNNING: unknown error` | Gradio コンテナを `20251020-5` 以降に更新し、`FF_API_BASE_URL` が正しいか確認。 |
| Wav2Lip / FaceFusion が失敗する | RunPod ログで `stdout` / `stderr` を確認。R2 からのダウンロード失敗や ffmpeg エラーが多い場合はバケット権限とファイル形式を見直してください。 |
| Redis 接続エラー | `JOBSTORE_REDIS_URL` を `rediss://` 形式で指定し、FastAPI 0.110.2 と Redis 5.x の組み合わせでは `ssl_cert_reqs` を文字列で渡す必要があります（本リポジトリでは自動設定済み）。 |
| 最終動画に音声が無い | FaceFusion Serverless のログで `audio_merge` の結果を確認。対象動画がサイレントの場合は R2 にアップロードした音声ファイルを見直してください。 |

---

## ライセンス

ベースとなる FaceFusion は [OpenRAIL-AS License](https://huggingface.co/spaces/LAION/CLIP/blob/main/LICENSE) に基づきます。本リポジトリで追加したサーバーレス関連のコードも同ライセンスに従います。
