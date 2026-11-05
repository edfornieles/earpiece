#!/usr/bin/env python3
"""Face matching for the catalogue: finds participants who agreed to it in the camera footage.

Run by catalogue.js (set it up once with `npm run setup-faces`). Reads a job from stdin:
  { "people": [{ "pid", "name", "photo" }], "windows": [{ "pid", "from", "to" }],
    "videos": [{ "cam", "camera", "file", "offset", "duration" }], "out": "<catalogue dir>", "step": 2 }
Times are seconds on the session clock. Only people in "people" are ever looked for, and only during
their own windows. Faces of anyone else are detected (to be compared) but nothing about them is kept:
no picture, no measurement, no record.

Writes to <out>:
  faces.jsonl        one line per sighting: { t, cam, camera, pid, name, score, box }
  appearances.json   sightings merged into stretches: { pid, name, camera, from, to, sightings, best }
  faces/<pid>/       the best few crops per camera, so a person can check the matches
Uses OpenCV's YuNet (detection) and SFace (recognition) models from models/.
"""
import json, os, subprocess, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')
THRESHOLD = float(os.environ.get('FACE_THRESHOLD', '0.40'))   # cosine similarity; SFace's own suggestion is 0.363
MAX_W = int(os.environ.get('FACE_FRAME_WIDTH', '2560'))        # 4K frames are scaled to this before detection
KEEP = 4                                                       # crops kept per person per camera


def log(*a):
    print('  faces:', *a, file=sys.stderr, flush=True)


def detector(w, h):
    d = cv2.FaceDetectorYN.create(os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx'), '', (w, h), 0.8, 0.3, 5000)
    d.setInputSize((w, h))
    return d


rec = cv2.FaceRecognizerSF.create(os.path.join(MODELS, 'face_recognition_sface_2021dec.onnx'), '')


def faces_in(img, det=None):
    h, w = img.shape[:2]
    det = det or detector(w, h)
    _, f = det.detect(img)
    return [] if f is None else list(f)


def feature(img, face):
    return rec.feature(rec.alignCrop(img, face))


def frames(video, start, length, step):
    """Yields (time-in-file, image) every `step` seconds from start for length seconds, decoded by ffmpeg."""
    vf = f"fps=1/{step},scale='min({MAX_W},iw)':-2"
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', f'{start:.2f}', '-t', f'{length:.2f}', '-i', video,
           '-vf', vf, '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']
    if sys.platform == 'darwin':
        cmd[3:3] = ['-hwaccel', 'videotoolbox']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    buf, i = b'', 0
    while True:
        chunk = p.stdout.read(1 << 20)
        if not chunk:
            break
        buf += chunk
        while True:
            a = buf.find(b'\xff\xd8')
            b = buf.find(b'\xff\xd9', a + 2) if a >= 0 else -1
            if a < 0 or b < 0:
                break
            img = cv2.imdecode(np.frombuffer(buf[a:b + 2], np.uint8), cv2.IMREAD_COLOR)
            buf = buf[b + 2:]
            if img is not None:
                yield start + i * step, img
            i += 1
    p.wait()


def main():
    job = json.load(sys.stdin)
    out, step = job['out'], float(job.get('step', 2))
    os.makedirs(out, exist_ok=True)

    # reference: the largest face in each registration photo
    refs = {}
    for p in job['people']:
        img = cv2.imread(p['photo'])
        if img is None:
            log(f"can't open the photo for {p['name']}")
            continue
        fs = faces_in(img)
        if not fs:
            log(f"no face found in the registration photo for {p['name']} — they'll need linking by hand")
            continue
        best = max(fs, key=lambda f: f[2] * f[3])
        refs[p['pid']] = {'name': p['name'], 'feat': feature(img, best)}
    if not refs:
        log('nobody to look for')
        json.dump([], open(os.path.join(out, 'appearances.json'), 'w'))
        open(os.path.join(out, 'faces.jsonl'), 'w').close()
        return

    windows = [w for w in job['windows'] if w['pid'] in refs]
    sightings, crops = [], {}
    for v in job['videos']:
        # the parts of this file that overlap anyone's window
        spans = []
        for w in windows:
            a, b = max(w['from'], v['offset']), min(w['to'], v['offset'] + v['duration'])
            if b - a > 0.5:
                spans.append([a, b])
        spans.sort()
        merged = []
        for s in spans:
            if merged and s[0] <= merged[-1][1] + step:
                merged[-1][1] = max(merged[-1][1], s[1])
            else:
                merged.append(s)
        det, size = None, None
        for a, b in merged:
            log(f"{v['camera']}: {a:.0f}–{b:.0f} s")
            for tf, img in frames(v['file'], a - v['offset'], b - a, step):
                t = round(v['offset'] + tf, 2)
                who = [pid for pid in refs if any(w['pid'] == pid and w['from'] <= t <= w['to'] for w in windows)]
                if not who:
                    continue
                h, w_ = img.shape[:2]
                if size != (w_, h):
                    det, size = detector(w_, h), (w_, h)
                for f in faces_in(img, det):
                    feat = feature(img, f)
                    scores = [(rec.match(refs[pid]['feat'], feat, cv2.FaceRecognizerSF_FR_COSINE), pid) for pid in who]
                    score, pid = max(scores)
                    if score < THRESHOLD:
                        continue   # not one of the people we're looking for: nothing kept
                    x, y, fw, fh = [int(round(n)) for n in f[:4]]
                    s = {'t': t, 'cam': v['cam'], 'camera': v['camera'], 'pid': pid, 'name': refs[pid]['name'],
                         'score': round(float(score), 3), 'box': [x, y, fw, fh], 'frame_width': w_}
                    sightings.append(s)
                    key = (pid, v['cam'])
                    pad = int(max(fw, fh) * 0.6)
                    crop = img[max(0, y - pad):y + fh + pad, max(0, x - pad):x + fw + pad]
                    lst = crops.setdefault(key, [])
                    lst.append((score, t, crop.copy()))
                    lst.sort(key=lambda c: -c[0])
                    del lst[KEEP:]

    with open(os.path.join(out, 'faces.jsonl'), 'w') as fh:
        for s in sorted(sightings, key=lambda s: s['t']):
            fh.write(json.dumps(s) + '\n')
    for (pid, cam), lst in crops.items():
        d = os.path.join(out, 'faces', pid)
        os.makedirs(d, exist_ok=True)
        for score, t, crop in lst:
            cv2.imwrite(os.path.join(d, f"{cam}_{int(t // 3600):02d}h{int(t % 3600 // 60):02d}m{int(t % 60):02d}s_{score:.2f}.jpg"), crop)

    # stretches: sightings of one person on one camera less than 3 steps apart
    apps = []
    for (pid, cam) in sorted({(s['pid'], s['cam']) for s in sightings}):
        ss = sorted([s for s in sightings if s['pid'] == pid and s['cam'] == cam], key=lambda s: s['t'])
        cur = None
        for s in ss:
            if cur and s['t'] - cur['to'] <= step * 3 + 0.01:
                cur['to'] = s['t']; cur['sightings'] += 1; cur['best'] = max(cur['best'], s['score'])
            else:
                cur = {'pid': pid, 'name': s['name'], 'cam': cam, 'camera': s['camera'], 'from': s['t'], 'to': s['t'], 'sightings': 1, 'best': s['score']}
                apps.append(cur)
    json.dump(apps, open(os.path.join(out, 'appearances.json'), 'w'), indent=1)
    log(f"{len(sightings)} sightings of {len(refs)} people")


if __name__ == '__main__':
    main()
