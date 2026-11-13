#!/usr/bin/env python3
"""Live face recognition for the Room page. One long-running process; JSON lines in and out.

  {"op":"enroll","pid":"p450031","path":"participants/p450031/photo.jpg"}
      -> {"op":"enroll","pid":...,"ok":true} or {"ok":false,"error":...}
  {"op":"forget","pid":"..."}                -> {"op":"forget","pid":...}
  {"op":"match","id":7,"jpeg":"<base64>"}    -> {"op":"match","id":7,"w":960,"h":540,
                                                  "faces":[{"box":[x,y,w,h],"pid":"p450031"|null,"score":0.61}]}

Only people enrolled here (registered with face matching agreed) can be named. Other faces are
detected only to be compared: their measurements are discarded and never written anywhere.
OpenCV YuNet (detection) + SFace (recognition), as in faces.py.
"""
import base64, json, os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')
THRESHOLD = float(os.environ.get('FACE_THRESHOLD', '0.40'))
rec = cv2.FaceRecognizerSF.create(os.path.join(MODELS, 'face_recognition_sface_2021dec.onnx'), '')
_det = {}
known = {}   # pid -> list of unit embeddings (registration photo + views learned in the room)


def detector(w, h):
    d = _det.get((w, h))
    if d is None:
        d = cv2.FaceDetectorYN.create(os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx'), '', (w, h), 0.7, 0.3, 5000)
        d.setInputSize((w, h)); _det[(w, h)] = d
    return d


def faces(img):
    h, w = img.shape[:2]
    _, found = detector(w, h).detect(img)
    out = []
    for f in (found if found is not None else []):
        feat = rec.feature(rec.alignCrop(img, f)).flatten()
        out.append((f, feat / (np.linalg.norm(feat) or 1)))
    return out


def reply(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()


for line in sys.stdin:
    try:
        m = json.loads(line)
        if m['op'] == 'enroll':
            img = cv2.imread(os.path.join(HERE, m['path']))
            if img is None: reply({'op': 'enroll', 'pid': m['pid'], 'ok': False, 'error': 'photo missing'}); continue
            # Registration photos can be large and portrait: scale so the face is a sensible size.
            s = min(1.0, 1280 / max(img.shape[:2]))
            if s < 1: img = cv2.resize(img, None, fx=s, fy=s)
            fs = faces(img)
            if not fs: reply({'op': 'enroll', 'pid': m['pid'], 'ok': False, 'error': 'no face in the registration photo'}); continue
            f, feat = max(fs, key=lambda x: x[0][2] * x[0][3])   # the largest face is the person registering
            known[m['pid']] = [feat] + [np.array(t, dtype=np.float32) for t in m.get('templates', [])]
            reply({'op': 'enroll', 'pid': m['pid'], 'ok': True})
        elif m['op'] == 'learn':
            if m['pid'] in known: known[m['pid']].append(np.array(m['emb'], dtype=np.float32)); known[m['pid']] = known[m['pid']][:60]
            reply({'op': 'learn', 'pid': m['pid']})
        elif m['op'] == 'forget':
            known.pop(m['pid'], None); reply({'op': 'forget', 'pid': m['pid']})
        elif m['op'] == 'match':
            img = cv2.imdecode(np.frombuffer(base64.b64decode(m['jpeg']), np.uint8), cv2.IMREAD_COLOR)
            if img is None: reply({'op': 'match', 'id': m['id'], 'faces': []}); continue
            h, w = img.shape[:2]
            rows = [(p, t) for p in known for t in known[p]]
            pids = [p for p, _ in rows]; mat = np.array([t for _, t in rows], dtype=np.float32) if rows else None
            out = []
            for f, feat in faces(img):
                pid, score = None, 0.0
                if mat is not None:
                    sims = mat @ feat; i = int(np.argmax(sims)); score = float(sims[i])
                    if score >= THRESHOLD: pid = pids[i]
                # The embedding goes back only so the server can learn more views of a person already named in the room.
                out.append({'box': [int(v) for v in f[:4]], 'pid': pid, 'score': round(score, 3) if pid else None, 'emb': [round(float(v), 4) for v in feat]})
            reply({'op': 'match', 'id': m['id'], 'w': w, 'h': h, 'faces': out})
    except Exception as e:  # never crash the worker on one bad message
        reply({'op': 'error', 'error': str(e)[:200]})
