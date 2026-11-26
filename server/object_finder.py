#!/usr/bin/env python3
"""Finds named studio objects in a camera picture by description (open-vocabulary detection, OWLv2).
Runs on this computer (Apple GPU when available). JSON lines in and out:

  {"id": 3, "jpeg": "<base64>", "queries": ["a brown leather armchair", "a small dark metal stool"]}
  -> {"id": 3, "w": 1920, "h": 1080, "found": [{"query": 0, "score": 0.41, "box": [x, y, w, h]}]}

At most one box per description (its best), and each box is claimed by one description only.
"""
import base64, io, json, os, sys
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
import torch
from PIL import Image
sys.dont_write_bytecode = True
from tabletop_lines import tabletop_lines
from transformers import Owlv2Processor, Owlv2ForObjectDetection

MODEL = os.environ.get('OBJECT_MODEL', 'google/owlv2-base-patch16-ensemble')
MIN_SCORE = float(os.environ.get('OBJECT_MIN_SCORE', '0.2'))
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
processor = Owlv2Processor.from_pretrained(MODEL)
model = Owlv2ForObjectDetection.from_pretrained(MODEL).to(device).eval()


def reply(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()


def iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    i = max(0, x2 - x1) * max(0, y2 - y1)
    return i / (a[2] * a[3] + b[2] * b[3] - i or 1)


reply({'ready': True, 'device': device})
for line in sys.stdin:
    try:
        m = json.loads(line)
        img = Image.open(io.BytesIO(base64.b64decode(m['jpeg']))).convert('RGB')
        w, h = img.size
        inputs = processor(text=[m['queries']], images=img, return_tensors='pt').to(device)
        with torch.no_grad():
            out = model(**inputs)
        side = max(w, h)   # OWLv2 pads to a square at the bottom/right, so boxes are in original pixels
        res = processor.image_processor.post_process_object_detection(out, threshold=MIN_SCORE, target_sizes=torch.tensor([[side, side]]))[0]
        cands = []
        for score, label, box in zip(res['scores'].tolist(), res['labels'].tolist(), res['boxes'].tolist()):
            x1, y1, x2, y2 = [max(0.0, v) for v in box]
            x2, y2 = min(x2, w), min(y2, h)
            if x2 - x1 > 4 and y2 - y1 > 4: cands.append({'query': int(label), 'score': round(score, 3), 'box': [round(x1), round(y1), round(x2 - x1), round(y2 - y1)]})
        found, taken = [], []
        for c in sorted(cands, key=lambda c: -c['score']):
            if any(f['query'] == c['query'] for f in found): continue          # one box per description
            if any(iou(c['box'], t) > 0.6 for t in taken): continue           # one description per box
            if c['query'] in m.get('rotationQueries', []):
                c['lines'] = tabletop_lines(img, c['box'])
            found.append(c); taken.append(c['box'])
        reply({'id': m['id'], 'w': w, 'h': h, 'found': found})
    except Exception as e:
        reply({'id': (m or {}).get('id') if isinstance(locals().get('m'), dict) else None, 'error': str(e)[:300]})
