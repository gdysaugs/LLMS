# wav2lip-onnx-HQ

Update 09.06.2025

- added garbage collection to free ram/vram after denoising audio  
  tested on RTX3060/6Gb running inference using audio denoiser, occlusion mask, face enhancer and frame enhancer at same time
  

Update 28.05.2025  

- removed 'final audio' option stuff
- added resemble audio denoiser to avoid unwanted lip movements  
  (not as good as vocal separation (eg. KimVocal_v2) but working similar in most cases)
- minor code optimizations
  

Update 29.04.2025 (inference_onnxModel_V2.py)

  - replaced occlusion mask with xseg occlusion
  - added option frame enhancer realEsrgan (clear_reality_x4 model included)
  - added option short fade-in/fade-out
  - added option for facemode 0 or 1 for better result on different face shapes  
    (0=portrait like orig. wav2lip, 1=square for less mouth opening)
  - bugfix crashing when using xseg and specific face is not detected  

Update 08.02.2025

  - optmized occlusion mask
  - Replaced insightface with retinaface detection/alignment for easier installation
  - Replaced seg-mask with faster blendmasker
  - Added free cropping of final result video
  - Added specific target face selection from first frame

.

Just another Wav2Lip HQ local installation, fully running on Torch to ONNX converted models for:
- face-detection
- face-recognition
- face-alignment
- face-parsing
- face-enhancement
- wav2lip inference.

.

Can be run on CPU or Nvidia GPU

I've made some modifications such as:
* New face-detection and face-alignment code. (working for ~ +- 60º head tilt)
* Four different face enhancers available, adjustable enhancement level .
* Choose pingpong loop instead of original loop function.
* Set cut-in/cut-out position to create the loop or cut longer video.
* Cut-in position = used frame if static is selected.
* Select the target face.
* Use two audio files, eg. vocal for driving and full music mix for final output.
* This version does not crash if no face is detected, it just continues ...

Type --help for all commandline parameters

.
 
Model download - https://drive.google.com/drive/folders/1BGl9bmMtlGEMx_wwKufJrZChFyqjnlsQ?usp=sharing  

.


Original wav2lip - https://github.com/Rudrabha/Wav2Lip

Face enhancers taken from -  https://github.com/harisreedhar/Face-Upscalers-ONNX

Face detection taken from - https://github.com/neuralchen/SimSwap

Face occluder taken from - https://github.com/facefusion/facefusion-assets/releases

Blendmasker extracted from - https://github.com/mapooon/BlendFace during onnx conversion

Face recognition for specifc face taken from - https://github.com/jahongir7174/FaceID  

Resemble-denoiser-ONNX adopted from - https://github.com/skeskinen/resemble-denoise-onnx-inference

.

.

---

## ローカル GPU 環境 (Docker) での実行手順メモ

この節では `/home/adama/wav2lip` に構築した Docker ベースの実行環境と、実際に行ったワークフローを記載する。日本語での運用手順書として利用できる。

### 1. モデル配置

Google Drive から取得した各種 ONNX/ZIP を配置済み。主なパスは以下の通り。

```
/home/adama/wav2lip/checkpoints/wav2lip.onnx
/home/adama/wav2lip/checkpoints/wav2lip_gan.onnx
/home/adama/wav2lip/enhancers/GFPGAN/GFPGANv1.4.onnx
/home/adama/wav2lip/faceID/recognition.onnx
/home/adama/wav2lip/blendmasker/blendmasker.onnx
/home/adama/wav2lip/xseg/xseg.onnx
/home/adama/wav2lip/resemble_denoiser/denoiser_fp16.onnx
```

### 2. Docker イメージの構築

`Dockerfile` は CUDA 11.8 + cuDNN ランタイムベース。Python 3.10 系の onnxruntime-gpu 1.14.1、GFPGAN 等を利用するためのライブラリを固定バージョンでインストールしている。

```bash
cd /home/adama/wav2lip
docker build -t wav2lip-onnx-hq:latest .
```

### 3. 入力メディアの配置

```
/home/adama/wav2lip/input/source.mp4   # 元動画
/home/adama/wav2lip/input/audio.mp3    # 音声 (口パク駆動)
```

### 4. 推論コマンド例

基本形（GFPGAN ブレンド 0.3）:

```bash
/usr/bin/time -f '%E' docker run --rm --gpus all \
  -v /home/adama/wav2lip/input:/input:ro \
  -v /home/adama/wav2lip/output:/output \
  wav2lip-onnx-hq:latest bash -lc \
  "mkdir -p temp hq_temp && python3 inference_onnxModel.py \
    --checkpoint_path checkpoints/wav2lip_gan.onnx \
    --face /input/source.mp4 \
    --audio /input/audio.mp3 \
    --outfile /output/wav2lip_gfpgan.mp4 \
    --enhancer gfpgan --blending 3 \
    --skip_crop_gui --skip_face_selection"
```

GFPGAN ブレンド 0.6 で強めに補正する場合は `--blending 6` とし、`--outfile` を変える。例:

```bash
/usr/bin/time -f '%E' docker run --rm --gpus all \
  -v /home/adama/wav2lip/input:/input:ro \
  -v /home/adama/wav2lip/output:/output \
  wav2lip-onnx-hq:latest bash -lc \
  "mkdir -p temp hq_temp && python3 inference_onnxModel.py \
    --checkpoint_path checkpoints/wav2lip_gan.onnx \
    --face /input/source.mp4 \
    --audio /input/audio.mp3 \
    --outfile /output/wav2lip_gfpgan_b6.mp4 \
    --enhancer gfpgan --blending 6 \
    --skip_crop_gui --skip_face_selection"
```

オプション概要:

- `--skip_crop_gui` … GUI での ROI 選択をスキップ（フルフレーム）。
- `--skip_face_selection` … 最初に検出された顔を自動使用。
- `--blending` … GFPGAN との合成比率 (1〜10 → 0.1〜1.0)。
- `--checkpoint_path` … 今回は `wav2lip_gan.onnx` (96px GAN モデル) を使用。

### 5. 実行ログと速度

- GFPGAN ブレンド 0.3: 約 19.9 秒（Docker 起動込み。GPU: RTX 3050）。
- GFPGAN ブレンド 0.6: 約 24.8 秒。
- 出力解像度: 600x680、長さ約 0.87 秒、30 fps。

### 6. 生成結果ファイル

```
/home/adama/wav2lip/output/wav2lip_gfpgan.mp4      (0.3 ブレンド, MD5: 2f985c91bfbb1998e1c988e75746574c)
/home/adama/wav2lip/output/wav2lip_gfpgan_b6.mp4   (0.6 ブレンド, MD5: 78e5a3ab8420d75501d3384cc41a7d4a)
```

### 7. Cloudflare R2 へのアップロード

`/home/adama/facefusion/docker/upload_to_r2.py` を利用。環境変数に R2 のエンドポイント・キーを指定し、オブジェクトキーを渡す。

例:

```bash
R2_ENDPOINT='https://511b7840b359d7f544847a3dfad8e85f.r2.cloudflarestorage.com' \
R2_BUCKET='llm' \
R2_ACCESS_KEY_ID='531e86339886fa78d9e31e79e86e68ab' \
R2_SECRET_ACCESS_KEY='930f9954d26f5b5308ae146b2db31673f6d025adf9a0a68a53930f3e3605bc84' \
python3 /home/adama/facefusion/docker/upload_to_r2.py \
  'wav2lip/results/20251013T071755Z_gfpgan.mp4' \
  /home/adama/wav2lip/output/wav2lip_gfpgan.mp4
```

アップロード後は presigned URL (または `R2_PUBLIC_BASE_URL` 設定時は CDN URL) で配布可能。今回取得した例:

- `https://511b7840b359d7f544847a3dfad8e85f.r2.cloudflarestorage.com/llm/wav2lip/results/20251013T071755Z_gfpgan.mp4`
- `https://511b7840b359d7f544847a3dfad8e85f.r2.cloudflarestorage.com/llm/wav2lip/results/20251013T073133Z_gfpgan_b6.mp4`

### 8. 改善ポイントメモ

- 高解像度結果が必要なら 384px モデル (`wav2lip_384*.onnx`) と対応コードの導入を検討。
- GFPGAN 効果をさらに強く出したい場合は `--blending` を上げる、`--hq_output` で Real-ESRGAN を併用。
- ROI を固定化したい場合は `--crop_roi x y w h` や `--face_roi` を追加指定すると GUI を使わずに精密なトリミングが可能。

以上が、今回成功したセットアップおよび運用手順のまとめ。

