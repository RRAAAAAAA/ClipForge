#!/usr/bin/env python3
"""Renders a vertical video that follows the people in a clip.
Usage: reframe.py <video> <start_sec> <duration_sec> <out.mp4> <width> <height> [square]
With "square" the output is 1:1 (width = height): 1 person = square following their face, 2 people = two stacked strips,
3+ people = square on whoever is speaking. The server places this square in the middle of the 9:16 frame.
1 person  -> full screen, camera follows their face smoothly
2 people  -> split screen: left person on top, right person below (each follows their face)
3+ people -> full screen on whoever is speaking (hard cut when the speaker changes)
No faces  -> centre crop. The output has no audio; the server adds audio, music and captions."""
import sys, os, subprocess
import numpy as np, cv2

src, start, dur, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
OW, OH = int(sys.argv[5]), int(sys.argv[6])
ASP = 1.0 if len(sys.argv) > 7 and sys.argv[7] == 'square' else 9 / 16  # shape of the main window
OUTFPS, FPS, AW = 30, 4, 800  # output fps, analysis fps, analysis width

cv2.setNumThreads(2)  # the host shows many more cores than this server may use
cap = cv2.VideoCapture(src)
sw, sh = int(cap.get(3)), int(cap.get(4))
cap.release()
AH = int(round(sh * AW / sw / 2) * 2)
S = sw / AW  # analysis pixels -> source pixels
# YuNet (small neural face detector, ships as yunet.onnx next to this file) finds side-on and small faces that the
# old Haar detector misses. If the model file is missing the Haar detectors below are used instead.
YU = None
try:
    _m = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yunet.onnx')
    if os.path.exists(_m):
        YU = cv2.FaceDetectorYN.create(_m, '', (AW, AH), 0.5, 0.3, 100)
except Exception as _e:
    print('YuNet unavailable, using Haar:', _e, file=sys.stderr)
    YU = None
HC = cv2.data.haarcascades
FRONT = [cv2.CascadeClassifier(HC + n) for n in ('haarcascade_frontalface_default.xml', 'haarcascade_frontalface_alt2.xml')]
PROFILE = cv2.CascadeClassifier(HC + 'haarcascade_profileface.xml')


def detect(g, bgr=None, deep=True):
    """YuNet first (handles faces turned sideways and small faces). The Haar passes only run as a fallback, when
    YuNet is missing or finds fewer than two faces."""
    out = []
    if YU is not None and bgr is not None:
        try:
            YU.setInputSize((AW, AH))
            _, res = YU.detect(bgr)
            if res is not None:
                for r in res:
                    x, y, w, h = [int(v) for v in r[:4]]
                    x0, y0 = max(0, x), max(0, y)
                    w, h = min(AW, x + w) - x0, min(AH, y + h) - y0
                    if w >= AW // 60 and h >= AW // 60:
                        out.append((x0, y0, w, h))
        except Exception as e:
            print('YuNet failed on a frame:', e, file=sys.stderr)
        if len(out) >= 2 or not deep:
            return out
    g = cv2.equalizeHist(g)
    out += [tuple(int(v) for v in f) for f in FRONT[0].detectMultiScale(g, 1.1, 4, minSize=(AW // 40, AW // 40))]
    if deep and len(out) < 2:
        out += [tuple(int(v) for v in f) for f in FRONT[1].detectMultiScale(g, 1.1, 4, minSize=(AW // 40, AW // 40))]
        ms = (AW // 32, AW // 32)
        out += [tuple(int(v) for v in f) for f in PROFILE.detectMultiScale(g, 1.1, 3, minSize=ms)]  # facing right
        for x, y, w, h in PROFILE.detectMultiScale(cv2.flip(g, 1), 1.1, 3, minSize=ms):  # facing left
            out.append((AW - int(x) - int(w), int(y), int(w), int(h)))
    return out


# ---------- 1. find faces (and mouth movement) at a low frame rate ----------
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-threads', '2', '-i', src,
                      '-vf', f'fps={FPS},scale={AW}:{AH}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                     stdout=subprocess.PIPE)
raw, prev = [], None  # raw[i] = detections: (x, y, w, h, mouth_motion), analysis pixels
while True:
    b = p.stdout.read(AW * AH * 3)
    if len(b) < AW * AH * 3:
        break
    bgr = np.frombuffer(b, np.uint8).reshape(AH, AW, 3)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    keep = []
    for f in sorted(detect(g, bgr), key=lambda f: -f[2]):  # drop duplicate detections of one face
        if all(abs((f[0] + f[2] / 2) - (k[0] + k[2] / 2)) > max(f[2], k[2]) * 0.7 for k in keep):
            keep.append(f)
    row = []
    for x, y, w, h in keep[:6]:
        mot = 0.0
        if prev is not None:  # change in the mouth area since the last frame = talking
            ya, yb, xa, xb = int(y + .62 * h), int(y + .95 * h), int(x + .2 * w), int(x + .8 * w)
            a, c = g[ya:yb, xa:xb].astype(np.float32), prev[ya:yb, xa:xb].astype(np.float32)
            if a.size:
                mot = float(np.abs(a - c).mean())
        row.append((x, y, w, h, mot))
    raw.append(row)
    prev = g
p.wait()
if not raw:
    raw = [[]]

# keep only detections that show up again nearby within ~2 seconds (removes one-off false alarms like trees or posters)
frames = []
for i, r in enumerate(raw):
    kept = []
    for f in r:
        cx, cy = f[0] + f[2] / 2, f[1] + f[3] / 2
        sup = sum(1 for j in range(max(0, i - 10), min(len(raw), i + 11)) if j != i and any(
            abs(cx - (q[0] + q[2] / 2)) < 0.06 * AW and abs(cy - (q[1] + q[3] / 2)) < 0.08 * AH for q in raw[j]))
        if sup >= 3:
            kept.append(f)
    kept = sorted(kept, key=lambda f: -f[3])[:4]
    frames.append(sorted([(x + w / 2, y + h / 2, w, h, m) for x, y, w, h, m in kept], key=lambda f: f[0]))
N = len(frames)

# ---------- 2. plan the layout over time ----------
cnt = np.array([len(r) for r in frames])
ns = [int(round(np.median(cnt[max(0, i - 3):i + 4]))) for i in range(N)]  # ignore one-frame flicker
segs, s0 = [], 0
for i in range(1, N + 1):  # new segment when the number of people changes or the camera cuts
    cut_ = i == N or ns[i] != ns[i - 1]
    if not cut_ and len(frames[i]) == len(frames[i - 1]) and len(frames[i]):
        cut_ = np.mean([abs(a[0] - b[0]) for a, b in zip(frames[i], frames[i - 1])]) > 0.12 * AW
    if cut_:
        segs.append([s0, i])
        s0 = i
k = 0
while k < len(segs):  # absorb blips shorter than about one second
    if segs[k][1] - segs[k][0] < FPS and len(segs) > 1:
        if k > 0:
            segs[k - 1][1] = segs[k][1]
            del segs[k]
        else:
            segs[1][0] = segs[0][0]
            del segs[0]
    else:
        k += 1


def smooth(series):
    """Fill gaps, then average over ~1.2 s so the camera glides with the person instead of jittering."""
    arr = np.array([s if s is not None else (np.nan, np.nan) for s in series], dtype=float)
    for c in (0, 1):
        v = arr[:, c]
        ok = ~np.isnan(v)
        if not ok.any():
            return None
        arr[:, c] = np.interp(np.arange(len(v)), np.flatnonzero(ok), v[ok])
        arr[:, c] = np.convolve(np.pad(arr[:, c], 3, mode='edge'), np.ones(7) / 7, mode='valid')
    return arr


plan = [None] * N  # per analysis frame: (key, mode, [(cx, cy, h) per slot] in source pixels)
for sid, (a, b) in enumerate(segs):
    n = ns[a]
    if n == 0:
        for i in range(a, b):
            plan[i] = ((sid, 0), 'center', [])
        continue
    ser = [smooth([(f[idx][0], f[idx][1]) if len(f) == n else None for f in frames[a:b]]) for idx in range(n)]
    hs = [float(np.median([f[idx][3] for f in frames[a:b] if len(f) == n] or [AW / 8])) for idx in range(n)]
    if any(s is None for s in ser):
        for i in range(a, b):
            plan[i] = ((sid, 0), 'center', [])
        continue
    if n <= 2:
        for i in range(a, b):
            plan[i] = ((sid, 0), 'full' if n == 1 else 'split',
                       [(ser[j][i - a][0] * S, ser[j][i - a][1] * S, hs[j] * S) for j in range(n)])
    else:  # 3+ people: follow whoever is speaking
        ms, cur, hold, run = np.zeros(n), 0, 99, 0
        for i in range(a, b):
            if len(frames[i]) == n:
                ms = 0.6 * ms + 0.4 * np.array([f[4] for f in frames[i]])
            best = int(ms.argmax())
            if best != cur and ms[best] > ms[cur] * 1.3 + 0.3 and hold >= FPS:
                cur, hold, run = best, 0, run + 1
            hold += 1
            plan[i] = ((sid, run), 'full', [(ser[cur][i - a][0] * S, ser[cur][i - a][1] * S, hs[cur] * S)])


def rect(cx, cy, h, aspect, zoom, lo, ytop):
    ch = min(sh, max(sh * lo, h * zoom))
    cw = ch * aspect
    if cw > sw:
        cw, ch = sw, sw / aspect
    x, y = min(max(cx - cw / 2, 0), sw - cw), min(max(cy - ch * ytop, 0), sh - ch)
    return int(x), int(y), max(2, int(cw)), max(2, int(ch))


def crop(fr, r, w, h):
    x, y, cw, ch = r
    return cv2.resize(fr[y:y + ch, x:x + cw], (w, h), interpolation=cv2.INTER_CUBIC)


def at(t):
    """Layout for output time t, gliding between analysis frames while the shot is unchanged."""
    f = min(t * FPS, N - 1)
    i0 = int(f)
    i1 = min(i0 + 1, N - 1)
    (k0, m0, a0), (k1, m1, a1) = plan[i0], plan[i1]
    if k0 != k1 or len(a0) != len(a1):
        return m0, a0
    w = f - i0
    return m0, [tuple(x + (y - x) * w for x, y in zip(u, v)) for u, v in zip(a0, a1)]


def compose(fr, t):
    mode, slots = at(t)
    if mode == 'split':
        hh = OH // 2
        return np.vstack([crop(fr, rect(*s, OW / hh, 3.4, 0.45, 0.42), OW, hh) for s in slots])
    if mode == 'full':
        return crop(fr, rect(*slots[0], ASP, 5.0, 0.7, 0.40), OW, OH)
    cw = min(sw, int(sh * ASP))
    ch = min(sh, int(cw / ASP))
    return crop(fr, ((sw - cw) // 2, (sh - ch) // 2, cw, ch), OW, OH)


# summary the server shows under the clip
import json
secs = {'full': 0.0, 'split': 0.0, 'center': 0.0}
for pl in plan:
    secs[pl[1]] += 1 / FPS
json.dump({'seconds': {k: round(v, 1) for k, v in secs.items()}, 'people': int(max(ns)), 'detector': 'YuNet' if YU is not None else 'Haar'}, open(out + '.json', 'w'))

# ---------- 3. render ----------
rd = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-threads', '2', '-i', src, '-vf', f'fps={OUTFPS}',
                       '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE, bufsize=sw * sh * 6)
wr = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}',
                       '-r', str(OUTFPS), '-i', '-', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17',
                       '-pix_fmt', 'yuv420p', '-threads', '2', out], stdin=subprocess.PIPE)
size, n = sw * sh * 3, 0
while True:
    b = rd.stdout.read(size)
    if len(b) < size:
        break
    wr.stdin.write(compose(np.frombuffer(b, np.uint8).reshape(sh, sw, 3), n / OUTFPS).tobytes())
    n += 1
wr.stdin.close()
rd.wait()
sys.exit(0 if wr.wait() == 0 and n > 0 else 1)
