#!/usr/bin/env python3
"""Server-side person tracking for the Room: YOLO pose with ByteTrack, on this computer's GPU.
Replaces detection in a browser tab: works at the camera's full resolution with no page open.

JSON lines in:   {"id": 7, "jpeg": "<base64>", "objects": true}
JSON lines out:  {"id": 7, "w": 2560, "h": 1440, "ms": 41,
                  "people":  [{"track": 3, "conf": 0.88, "box": [x, y, w, h], "kp": [[x, y, conf] × 17]}],
                  "objects": [{"cls": "chair", "conf": 0.5, "box": [x, y, w, h]}]}     # only when asked
Keypoints are COCO order: 0 nose, 1-2 eyes, 3-4 ears, 5-6 shoulders, 7-8 elbows, 9-10 wrists,
11-12 hips, 13-14 knees, 15-16 ankles. Pixels in the frame received.
Track ids persist across frames (ByteTrack), so a person keeps the same id through brief misses.
"""
import base64, json, os, sys, time
import numpy as np
import cv2
from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')
device = 'mps'
try:
    import torch
    if not torch.backends.mps.is_available(): device = 'cpu'
except Exception:
    device = 'cpu'
pose = YOLO(os.path.join(MODELS, os.environ.get('POSE_MODEL', 'yolo11s-pose.pt')))
det = YOLO(os.path.join(MODELS, os.environ.get('DETECT_MODEL', 'yolo11s.pt')))
OBJECT_CLASSES = {'chair', 'couch', 'bench', 'dining table', 'suitcase', 'backpack', 'handbag', 'potted plant', 'tv', 'dog', 'cat'}
IMGSZ = int(os.environ.get('POSE_IMGSZ', '1280'))


def merge(people):
    """One body found twice (e.g. seated: torso alone, and torso plus legs under a table) becomes one:
    boxes that mostly overlap and whose shoulders coincide are joined, keeping each joint's best sighting."""
    def inter(a, b):
        x = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])); y = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])); return x * y
    def shoulders(p):
        s = [k for k in (p['kp'][5], p['kp'][6]) if k[2] > 0.4]
        return (sum(k[0] for k in s) / len(s), sum(k[1] for k in s) / len(s)) if s else None
    people = sorted(people, key=lambda p: -p['conf']); out = []
    for p in people:
        for q in out:
            small = min(p['box'][2] * p['box'][3], q['box'][2] * q['box'][3]) or 1
            a, b = shoulders(p), shoulders(q)
            near = a and b and abs(a[0] - b[0]) + abs(a[1] - b[1]) < 0.25 * max(p['box'][2], q['box'][2])
            if inter(p['box'], q['box']) / small > 0.6 and near:
                q['kp'] = [x if x[2] >= y[2] else y for x, y in zip(p['kp'], q['kp'])]
                x0, y0 = min(p['box'][0], q['box'][0]), min(p['box'][1], q['box'][1])
                x1, y1 = max(p['box'][0] + p['box'][2], q['box'][0] + q['box'][2]), max(p['box'][1] + p['box'][3], q['box'][1] + q['box'][3])
                q['box'] = [x0, y0, x1 - x0, y1 - y0]; break
        else:
            out.append(p)
    return out


def reply(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()


reply({'ready': True, 'device': device})
for line in sys.stdin:
    m = None
    try:
        m = json.loads(line)
        img = cv2.imdecode(np.frombuffer(base64.b64decode(m['jpeg']), np.uint8), cv2.IMREAD_COLOR)
        if img is None: reply({'id': m['id'], 'error': 'bad frame'}); continue
        h, w = img.shape[:2]; t0 = time.time()
        r = pose.track(img, persist=True, tracker='bytetrack.yaml', classes=[0], conf=0.3, imgsz=IMGSZ, device=device, verbose=False)[0]
        people = []
        if r.boxes is not None and len(r.boxes):
            ids = r.boxes.id.int().tolist() if r.boxes.id is not None else [None] * len(r.boxes)
            kps = r.keypoints.data.tolist() if r.keypoints is not None else [[]] * len(r.boxes)
            for tid, b, c, kp in zip(ids, r.boxes.xyxy.tolist(), r.boxes.conf.tolist(), kps):
                if tid is None: continue
                people.append({'track': tid, 'conf': round(c, 3), 'box': [round(b[0], 1), round(b[1], 1), round(b[2] - b[0], 1), round(b[3] - b[1], 1)],
                               'kp': [[round(p[0], 1), round(p[1], 1), round(p[2], 3)] for p in kp]})
        people = merge(people)
        out = {'id': m['id'], 'w': w, 'h': h, 'people': people}
        if m.get('objects'):
            d = det.predict(img, conf=0.25, imgsz=IMGSZ, device=device, verbose=False)[0]
            names = d.names; objs = []
            for b, c, k in zip(d.boxes.xyxy.tolist(), d.boxes.conf.tolist(), d.boxes.cls.int().tolist()):
                if names[k] in OBJECT_CLASSES: objs.append({'cls': names[k], 'conf': round(c, 3), 'box': [round(b[0], 1), round(b[1], 1), round(b[2] - b[0], 1), round(b[3] - b[1], 1)]})
            out['objects'] = objs
        out['ms'] = round((time.time() - t0) * 1000)
        reply(out)
    except Exception as e:
        reply({'id': (m or {}).get('id'), 'error': str(e)[:300]})
