"""How the camera's picture moved since a reference picture of the same position.

Usage: register_view.py reference.jpg current.jpg
Prints JSON: {"ok", "G": 3x3 row-major map from reference picture to current picture in 0..1 units,
"inliers", "shift": [dx, dy] of the picture centre in 0..1 units}.
A pan/tilt turn moves the whole picture by a homography, so matching fixed features (walls, shelves,
furniture) gives the correction even with people moving in the room.
"""
import json
import sys

import cv2
import numpy as np

WIDTH = 1920  # match at half of 4K: fast, and still sub-pixel at full size after scaling


def load(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(json.dumps({"ok": False, "error": "unreadable picture"}))
    scale = WIDTH / img.shape[1]
    return cv2.resize(img, (WIDTH, round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)


def main(ref_path, cur_path):
    a, b = load(ref_path), load(cur_path)
    h, w = a.shape
    orb = cv2.ORB_create(5000)
    ka, da = orb.detectAndCompute(a, None)
    kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None:
        return {"ok": False, "error": "no features"}
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    good = [m for m, n in (p for p in matches if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 30:
        return {"ok": False, "error": "too few matches", "inliers": len(good)}
    pa = np.float32([ka[m.queryIdx].pt for m in good])
    pb = np.float32([kb[m.trainIdx].pt for m in good])
    G, mask = cv2.findHomography(pa, pb, cv2.RANSAC, 2.0)
    inliers = int(mask.sum()) if mask is not None else 0
    if G is None or inliers < 30:
        return {"ok": False, "error": "no consistent movement", "inliers": inliers}
    S = np.diag([1 / w, 1 / h, 1.0])
    Gn = S @ G @ np.linalg.inv(S)
    Gn = Gn / Gn[2, 2]
    c = Gn @ np.array([0.5, 0.5, 1.0])
    return {"ok": True, "G": [float(v) for v in Gn.flatten()], "inliers": inliers,
            "shift": [float(c[0] / c[2] - 0.5), float(c[1] / c[2] - 0.5)]}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], sys.argv[2])))
