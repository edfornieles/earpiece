"""Extract visible straight segments near the detected furniture."""
import cv2
import numpy as np


def tabletop_lines(image, box):
    w, h = image.size
    x, y, bw, bh = box
    left, top = max(0, x - bw // 12), max(0, y - bh // 12)
    right, bottom = min(w, x + bw + bw // 12), min(h, y + bh + bh // 12)
    crop = np.asarray(image.crop((left, top, right, bottom)).convert('L'))
    if min(crop.shape) < 12:
        return []
    scale = min(1, 900 / max(crop.shape))
    if scale < 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    segments = cv2.createLineSegmentDetector().detect(crop)[0]
    if segments is None:
        return []
    lines = sorted(segments.reshape(-1, 4), key=lambda p: -np.hypot(p[0]-p[2], p[1]-p[3]))
    return [[[float((p[i]/scale + left)/w), float((p[i+1]/scale + top)/h)] for i in (0, 2)]
            for p in lines[:64] if np.hypot(p[0]-p[2], p[1]-p[3]) >= 20]
