#!/usr/bin/env python3
"""Finds faces in camera pictures, for scores that need to read expressions (Describing).

Runs as one long-lived process; each line on stdin is a job, each reply one line on stdout:
  in : {"images": ["<path>", ...]}
  out: {"faces": [{"image": i, "box": [x, y, w, h], "score": s, "size": h}, ...]}   (boxes in pixels, best first)
Uses OpenCV's YuNet model (models/face_detection_yunet_2023mar.onnx), as face matching does. Keeps nothing.
"""
import json, os, sys
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'models', 'face_detection_yunet_2023mar.onnx')
det = None

for line in sys.stdin:
    try:
        job = json.loads(line); faces = []
        for i, p in enumerate(job.get('images', [])):
            img = cv2.imread(p)
            if img is None: continue
            h, w = img.shape[:2]
            if det is None: det = cv2.FaceDetectorYN.create(MODEL, '', (w, h), 0.6)
            det.setInputSize((w, h))
            _, found = det.detect(img)
            for f in (found if found is not None else []):
                x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[-1])
                faces.append({'image': i, 'box': [x, y, fw, fh], 'score': score, 'size': fh})
        faces.sort(key=lambda f: -(f['size'] * f['score']))
        sys.stdout.write(json.dumps({'faces': faces}) + '\n'); sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({'faces': [], 'error': str(e)}) + '\n'); sys.stdout.flush()
