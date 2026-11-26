#!/usr/bin/env python3
"""Finds faces in camera pictures, for scores that need to read expressions (Describing).

Runs as one long-lived process; each line on stdin is a job, each reply one line on stdout:
  in : {"images": ["<path>", ...], "embed": false}
  out: {"faces": [{"image": i, "box": [x, y, w, h], "score": s, "size": h, "w": W, "h": H, "feat": [...]?}, ...]}
       boxes in pixels, best first; with "embed", each face also gets a recognition vector (SFace) so a camera
       can follow one particular person.
Uses OpenCV's YuNet model (models/face_detection_yunet_2023mar.onnx), as face matching does. Keeps nothing.
"""
import json, os, sys
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'models', 'face_detection_yunet_2023mar.onnx')
REC = os.path.join(HERE, 'models', 'face_recognition_sface_2021dec.onnx')
det = None; rec = None

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
                face = {'image': i, 'box': [x, y, fw, fh], 'score': score, 'size': fh, 'w': w, 'h': h}
                if job.get('embed') and fh >= 24:
                    if rec is None: rec = cv2.FaceRecognizerSF.create(REC, '')
                    v = rec.feature(rec.alignCrop(img, f))[0]
                    face['feat'] = [round(float(a), 5) for a in v / ((v ** 2).sum() ** 0.5 or 1)]
                faces.append(face)
        faces.sort(key=lambda f: -(f['size'] * f['score']))
        sys.stdout.write(json.dumps({'faces': faces}) + '\n'); sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({'faces': [], 'error': str(e)}) + '\n'); sys.stdout.flush()
