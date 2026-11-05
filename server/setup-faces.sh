#!/bin/bash
# One-time setup for face matching: a private Python environment with OpenCV, and the two face models.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then echo "Python 3 is missing. Install it with:  brew install python"; exit 1; fi
echo "• Python environment (.faces-venv)…"
[ -x .faces-venv/bin/python ] || "$PY" -m venv .faces-venv
.faces-venv/bin/pip install --quiet --upgrade pip
.faces-venv/bin/pip install --quiet opencv-python-headless numpy
mkdir -p models
BASE=https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models
for m in face_detection_yunet/face_detection_yunet_2023mar.onnx face_recognition_sface/face_recognition_sface_2021dec.onnx; do
  f=models/$(basename $m)
  if [ ! -s "$f" ] || [ $(wc -c < "$f") -lt 100000 ]; then echo "• downloading $(basename $m)…"; curl -fsSL -o "$f" "$BASE/$m"; fi
done
.faces-venv/bin/python -c "import cv2; cv2.FaceDetectorYN; cv2.FaceRecognizerSF; print('• OpenCV', cv2.__version__, 'ready')"
echo "Face matching is set up. It runs as part of each session's catalogue."
