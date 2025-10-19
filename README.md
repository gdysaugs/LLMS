# LLMS Deployment Playbooks

このリポジトリは RunPod 上で運用している以下 3 つのワークロードを再現するための手順メモと設定情報をまとめたものです。

- `facefusion/` – RunPod Serverless で動作させている FaceFusion + Wav2Lip パイプラインの構成メモ
- `gptsovits/` – GPT-SoVITS WebUI を Docker コンテナ (`gptsovits:v4`) で再現するための手順
- `wav2lip/` – Wav2Lip ONNX 版推論パイプラインのセットアップ手順メモ

モデルの学習済みウェイトはすべてそれぞれのコンテナイメージ内に同梱しており、リポジトリではコードや手順のみを管理しています。必要な場合は各 README 内のリンクやメモを参照して取得してください。

## ディレクトリ構成

```
facefusion/  # RunPod Serverless 用パイプラインのメモと環境変数一覧
gptsovits/   # GPT-SoVITS コンテナの再現手順と R2 連携メモ
wav2lip/     # Wav2Lip ONNX 版の実行メモ（モデルはコンテナ内に収録）
```

## 利用方法

1. 必要なコンテナイメージを Docker Hub から pull するか、README のビルド手順に従って再ビルドします。
2. Cloudflare R2 や Upstash Redis の認証情報を README に記載の環境変数で設定します。
3. RunPod Serverless / FastAPI / Gradio の各エンドポイントを README 通りに構成します。
4. `gptsovits/` の手順に沿って推論用スクリプトや R2 連携をセットアップします。

## 注意事項

- 大容量ファイル（`.onnx` や `.pth` などのモデル重み）はバージョン管理対象から除外しています。
- 本リポジトリのコミットには機密情報を含めません。API キーやアクセストークンは **環境変数** で渡してください。
- Cloudflare R2 のアクセスキーは使用後に必ずローテーションし、RunPod 側にも最小限の権限のみを付与してください。

## ライセンス

各コンポーネントのライセンスについてはサブディレクトリの README を参照してください。FaceFusion / Wav2Lip / GPT-SoVITS 本体のライセンスに従って利用してください。
