# GPT-SoVITS 再現手順（`gptsovits:v4` イメージ用）

このドキュメントは `\\wsl.localhost\Ubuntu-22.04\home\adama\gptsovits` に構築した GPT-SoVITS 環境を、いつでも同じ構成で再現できるよう整理したものです。

---

## 1. 含まれているアセットと構成

Docker イメージ `gptsovits:v4` には以下をすべて内包しています。

- ユーザー提供 SoVITS 重み  
  `models/custom/gpt_sovits_models_hscene-e17.ckpt`
- v4 系事前学習モデル  
  `s2Gv4.pth`、`vocoder.pth`、`models--nvidia--bigvgan_v2_24khz_100band_256x/*` など
- 中国語 BERT/HuBERT、fast_langdetect、その他補助モデル
- 参照音声（mp3）と、4 秒パディング済みの生成音声（wav）

### 追加したスクリプト

| ファイル名 | 役割 |
| --- | --- |
| `scripts/check_ckpt.py` | SoVITS/GPT 重みの構造を簡易確認 |
| `scripts/upload_r2.py` | boto3 を使った Cloudflare R2 へのアップロード |
| `scripts/run_inference.sh` | 参照音声へ 4 秒パディングを付与してから CLI 推論 |

### CLI の主な改修

- `GPT_SoVITS/inference_cli.py`  
  - `ja/en/zh` などの簡易コードで言語指定が可能  
  - `ref_text=free` を自動検出し、`ref_free=True` としてエンジンに渡す
- `GPT_SoVITS/inference_webui.py`  
  - v4 モデルでも明示的な `ref_free` 指定を許容

### テキスト・音声の調整

- 参照テキストとターゲットテキストを BOM なしで再保存
- コンテナ実行時に `ffmpeg` で 4 秒パッドを挿入し、3～60 秒要件を満たす

---

## 2. ビルド手順

ソースを更新した際は必ず再ビルドしてください。

```powershell
docker build -t gptsovits:v4 \\wsl.localhost\Ubuntu-22.04\home\adama\gptsovits
```

---

## 3. 推論（GPU 必須）

### 事前準備

ホスト側の `scripts/run_inference.sh` をコンテナから実行するため、権限を付与しておきます。

```bash
chmod +x /home/adama/gptsovits/scripts/run_inference.sh
```

### 推論実行

推論スクリプトは参照音声へ 4 秒のパディングを付与したあと CLI を起動します。  
以下のコマンドでホスト上の `scripts/` をコンテナへマウントし、生成結果を直接 Cloudflare R2 へアップロードできます（ローカルには残りません）。  
参照音声と同じ台詞の文字起こしを `RUN_INFERENCE_REF_TEXT` に渡すことでノイズのない生成が再現できます。

```powershell
docker run --rm --gpus all ^
  -v /home/adama/gptsovits/scripts:/workspace/GPT-SoVITS/scripts ^
  -e RUN_INFERENCE_R2_ENDPOINT=https://511b7840b359d7f544847a3dfad8e85f.r2.cloudflarestorage.com ^
  -e RUN_INFERENCE_R2_ACCESS_KEY=<アクセスキー> ^
  -e RUN_INFERENCE_R2_SECRET_KEY=<シークレットキー> ^
  -e RUN_INFERENCE_R2_BUCKET=llm ^
  -e RUN_INFERENCE_R2_KEY=gptsovits/output/output.wav ^
  -e RUN_INFERENCE_REF_TEXT="こんにちはお兄さん。" ^
  gptsovits:v4 ^
  bash -lc 'cd /workspace/GPT-SoVITS && scripts/run_inference.sh "こんにちはお兄さん"'
```

- R2 関連の環境変数が設定されている場合、生成音声は `scripts/upload_r2.py` を通じて `s3://<バケット>/<キー>` に送られ、ローカルファイルは削除されます。ローカルにも残したいときは `-e RUN_INFERENCE_KEEP_LOCAL_OUTPUT=true` を追加してください。
- 参照音声は最大 60 秒まで使用され、余剰は `ffmpeg` の `atrim` で切り捨てられます（不足分は 4 秒分のパディングが自動挿入されます）。
- 参照音声が存在する場合は `source_padded.wav`（約 4 秒）を優先的に使用し、なければ `source.mp3` を自動変換します。必要に応じて `RUN_INFERENCE_REF_AUDIO` で明示指定してください。
- 推論本体は API v2 と同じ `TTS_infer_pack.TTS` パイプライン（`top_k=5`、`top_p=1`、`temperature=1`、`sample_steps=32` など。参照: `GPT_SoVITS/TTS_infer_pack/TTS.py:997` 付近）で動作します。旧 `get_tts_wav` よりもざらつきが抑えられるので、基本はこちらを使います。各値は `RUN_INFERENCE_TOP_K` / `RUN_INFERENCE_TOP_P` / `RUN_INFERENCE_TEMPERATURE` / `RUN_INFERENCE_SAMPLE_STEPS` で上書きできます。
- 参照音声に対応する原稿（`prompt_text`）を指定しない場合、内部でターゲットテキストを流用しますが、同じセリフを読ませて録音した文字起こしを `RUN_INFERENCE_REF_TEXT`（もしくは `RUN_INFERENCE_REF_TEXT_FILE`）で渡すとノイズが発生しません。
- 実行ログには `jieba` からの非推奨警告が表示されますが、依存をアップグレードしない限りは無視して問題ありません。
- 出力ピークはデフォルトで 0.9 に正規化されます。必要に応じて `-e RUN_INFERENCE_TARGET_PEAK=0.95` のように指定してください。追加の増幅を行いたい場合は `RUN_INFERENCE_GAIN_DB` を設定します（例: `RUN_INFERENCE_GAIN_DB=+3dB`、無効化時は `off`）。

- #### 日本語アクセントを安定させるために
  - `data/ref_text.txt` を `free` のままにしても CLI がターゲット文から音素列を補完し、`ref_free` モードのアクセント崩れを抑えるようになりました。より厳密に合わせたい場合は参照原稿を書き込むか `RUN_INFERENCE_REF_TEXT` / `RUN_INFERENCE_REF_TEXT_FILE` で直接指定してください。
  - `RUN_INFERENCE_JA_WITH_PROSODY` を `true` / `false` で切り替えると PyOpenJTalk のプロソディ記号利用を制御できます（既定値は `false`）。必要に応じて `true` に切り替えると抑揚を強調できます。
  - `ref_free` のままでも `RUN_INFERENCE_REPETITION_PENALTY` や `RUN_INFERENCE_PARALLEL_INFER` を調整すると語尾の伸びやノイズが緩和されます。必要に応じて 1.15～1.3 付近から微調整してください。

- 既存コンテナに入って手動で実行したい場合は、上記コマンドから `--rm` を外して `docker exec` で入った後、同じスクリプトを呼び出してください。

---

## 4. Cloudflare R2 へのアップロード

生成した音声と元の参照音声は、以下のコマンドでアップロード済みです。同じ手順で再実行できます。

```bash
python scripts/upload_r2.py \
  --endpoint https://511b7840b359d7f544847a3dfad8e85f.r2.cloudflarestorage.com \
  --access_key <アクセスキー> \
  --secret_key <シークレットキー> \
  --bucket llm \
  --file /workspace/data/reference/source.mp3 gptsovits/source/source.mp3 \
  --file /workspace/GPT-SoVITS/outputs/gptsovits_output.wav gptsovits/output/output.wav
```

- アクセスキー／シークレットキーは機密情報なので、用途が終わったらローテーションすることを推奨します。

---

## 5. 音量調整（任意）

出力音量が小さい場合は環境変数でチューニングします。

- `RUN_INFERENCE_TARGET_PEAK`: SoVITS 推論直後に適用するピークリミット（既定 0.9）
- `RUN_INFERENCE_GAIN_DB`: `ffmpeg volume` で最終出力を増幅／減衰（既定 `off`）
- `RUN_INFERENCE_LOUDNORM`: `true`（既定）で `ffmpeg loudnorm=I=-14:LRA=11:TP=-1.5` を適用。`off`/`false` で無効化、独自パラメータを使いたい場合は `RUN_INFERENCE_LOUDNORM_FILTER` にフィルタ式を設定。
- `RUN_INFERENCE_REF_TEXT` / `RUN_INFERENCE_REF_TEXT_FILE`: 参照音声の文字起こしを指定（空の場合はターゲットテキストを流用）。
- `RUN_INFERENCE_PARALLEL_INFER` / `RUN_INFERENCE_SPLIT_BUCKET` / `RUN_INFERENCE_REPETITION_PENALTY`: API v2 相当の並列推論・繰り返し抑制パラメータ。ノイズが気になる場合は `RUN_INFERENCE_REPETITION_PENALTY=1.1` のように軽めに調整する選択肢もあります。
- ノイズレス運用の目安: `RUN_INFERENCE_REF_TEXT` に参照台詞、`RUN_INFERENCE_REPETITION_PENALTY=1.3` 前後、`RUN_INFERENCE_PARALLEL_INFER=true` の組み合わせが最も安定しました。

`RUN_INFERENCE_TARGET_PEAK` を下げてから `RUN_INFERENCE_GAIN_DB` を上げるとクリップを避けつつ音量を上げられます。必要であれば `RUN_INFERENCE_KEEP_LOCAL_OUTPUT=true` を指定してコンテナ内の WAV を取り出し、手動で `loudnorm` などを試すのも手です。

---

## 6. カスタマイズのヒント

- 別の文章や言語を読み上げたい場合は `scripts/run_inference.sh` の引数を差し替えるか、`inference_cli.py` を直接呼び出します。
- 大容量モデルは `models/pretrained_models/` 以下に集約されています。ファイルを追加・更新したら必ずイメージを再ビルドしてください。
- R2 に別の成果物を保存したいときは、上記 `scripts/upload_r2.py` のコマンドを再利用できます。

---

## 7. 参考パス

- `Dockerfile`  
- `models/pretrained_models/*`  
- `scripts/check_ckpt.py`  
- `scripts/upload_r2.py`  
- `scripts/run_inference.sh`  
- `scripts/tts_cli.py`  
- 出力保存先（既定）：`s3://llm/gptsovits/output/output.wav`（`RUN_INFERENCE_R2_KEY` で変更可能）

以上を参照すれば、現在の環境を同じ状態で復元できます。
