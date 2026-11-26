#!/usr/bin/env python3
"""Crops a studio portrait to a straight-on, face-centred square, so every face in the film lines up.

  portrait_crop.py <original.jpg> <out.jpg> [x y size]

Without x y size it finds the largest face (OpenCV YuNet, models/) and frames head and shoulders: the face takes
about 38% of the height, a little above centre, like a passport photo. With x y size (pixels in the original) it
uses that square instead, so a person can nudge the crop. Prints the square it used as JSON: {"x","y","size","auto"}.
"""
import json, os, sys
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_SIZE = 1024


def largest_face(img):
    s = min(1.0, 1280 / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=s, fy=s) if s < 1 else img
    h, w = small.shape[:2]
    det = cv2.FaceDetectorYN.create(os.path.join(HERE, 'models', 'face_detection_yunet_2023mar.onnx'), '', (w, h), 0.7)
    _, faces = det.detect(small)
    if faces is None or not len(faces):
        return None
    f = max(faces, key=lambda f: f[2] * f[3])
    return [v / s for v in f[:4]]


def main():
    src, out = sys.argv[1], sys.argv[2]
    img = cv2.imread(src)
    if img is None:
        raise SystemExit('cannot read the photo')
    H, W = img.shape[:2]
    if len(sys.argv) >= 6:
        x, y, size = (int(float(v)) for v in sys.argv[3:6]); auto = False
    else:
        f = largest_face(img)
        if f is None:
            raise SystemExit('no face found in the photo')
        fx, fy, fw, fh = f
        size = fh / 0.38
        cx, cy = fx + fw / 2, fy + fh / 2 + fh * 0.22   # face sits a little above the centre of the square
        x, y = cx - size / 2, cy - size / 2; auto = True
    size = int(min(size, W, H))
    x = int(max(0, min(W - size, x))); y = int(max(0, min(H - size, y)))
    crop = cv2.resize(img[y:y + size, x:x + size], (OUT_SIZE, OUT_SIZE), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out, crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(json.dumps({'x': x, 'y': y, 'size': size, 'auto': auto}))


if __name__ == '__main__':
    main()
