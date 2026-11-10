#!/usr/bin/env python3
"""Plans a vertical (9:16) layout for a clip by finding faces and who is speaking.
Usage: reframe.py <video> <start_sec> <duration_sec>   ->  prints JSON shots.
1 person  -> full screen on them
2 people  -> split screen (left person on top, right person below)
3+ people -> full screen on whoever is speaking (switches when the speaker changes)
No faces  -> centre crop."""
import sys, json, subprocess
import numpy as np, cv2

src, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
FPS, W = 6, 640
cap = cv2.VideoCapture(src)
sw, sh = int(cap.get(3)), int(cap.get(4))
cap.release()
H = int(round(sh * W / sw / 2) * 2)
S = sw / W
casc = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', src,
                      '-vf', f'fps={FPS},scale={W}:{H}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                     stdout=subprocess.PIPE)
frames, prev = [], None  # frames[i] = faces sorted left to right: (cx, cy, w, h, mouth_motion)
while True:
    b = p.stdout.read(W * H)
    if len(b) < W * H:
        break
    g = np.frombuffer(b, np.uint8).reshape(H, W)
    found = sorted((tuple(int(v) for v in f) for f in casc.detectMultiScale(g, 1.15, 6, minSize=(W // 22, W // 22))),
                   key=lambda f: -f[2])
    keep = []
    for f in found:  # drop duplicate detections of the same face
        if all(abs((f[0] + f[2] / 2) - (k[0] + k[2] / 2)) > max(f[2], k[2]) * 0.7 for k in keep):
            keep.append(f)
    keep = sorted(keep[:4], key=lambda f: f[0])
    row = []
    for x, y, w, h in keep:
        mot = 0.0
        if prev is not None:  # how much the mouth area changed since the last frame
            ya, yb, xa, xb = int(y + .62 * h), int(y + .95 * h), int(x + .2 * w), int(x + .8 * w)
            a, c = g[ya:yb, xa:xb].astype(np.float32), prev[ya:yb, xa:xb].astype(np.float32)
            if a.size:
                mot = float(np.abs(a - c).mean())
        row.append((x + w / 2, y + h / 2, w, h, mot))
    frames.append(row)
    prev = g
p.wait()
N = len(frames)
if N == 0:
    print(json.dumps({'shots': [{'t0': 0, 'mode': 'center', 't1': dur, 'crops': []}]}))
    sys.exit(0)

cnt = np.array([len(r) for r in frames])
ns = [int(round(np.median(cnt[max(0, i - 3):i + 4]))) for i in range(N)]  # ignore one-frame flicker

# split into segments where the number of people changes or the camera cuts
segs, s0 = [], 0
for i in range(1, N + 1):
    cut = i == N or ns[i] != ns[i - 1]
    if not cut and len(frames[i]) == len(frames[i - 1]) and len(frames[i]):
        shift = np.mean([abs(a[0] - b[0]) for a, b in zip(frames[i], frames[i - 1])])
        cut = shift > 0.12 * W
    if cut:
        segs.append([s0, i])
        s0 = i
k = 0
while k < len(segs):  # absorb segments shorter than about one second
    if segs[k][1] - segs[k][0] < FPS and len(segs) > 1:
        if k > 0:
            segs[k - 1][1] = segs[k][1]
            del segs[k]
        else:
            segs[1][0] = segs[0][0]
            del segs[0]
    else:
        k += 1


def crop(face, aspect, zoom, lo, ytop):
    cx, cy, w, h = (v * S for v in face[:4])
    ch = min(sh, max(sh * lo, h * zoom))
    cw = ch * aspect
    if cw > sw:
        cw, ch = sw, sw / aspect
    x, y = min(max(cx - cw / 2, 0), sw - cw), min(max(cy - ch * ytop, 0), sh - ch)
    e = lambda v: int(v) // 2 * 2
    return {'x': e(x), 'y': e(y), 'w': e(cw), 'h': e(ch)}


full = lambda f: crop(f, 9 / 16, 5.0, 0.7, 0.40)
half = lambda f: crop(f, 1080 / 960, 3.4, 0.45, 0.42)

shots = []
for a, b in segs:
    n = ns[a]
    rows = [frames[i] for i in range(a, b) if len(frames[i]) == n]
    if n == 0 or not rows:
        shots.append({'t0': a / FPS, 't1': b / FPS, 'mode': 'center', 'crops': []})
        continue
    st = np.median(np.array([[f[:4] for f in r] for r in rows]), axis=0)  # stable face boxes
    if n == 1:
        shots.append({'t0': a / FPS, 't1': b / FPS, 'mode': 'full', 'crops': [full(st[0])]})
    elif n == 2:
        shots.append({'t0': a / FPS, 't1': b / FPS, 'mode': 'split', 'crops': [half(st[0]), half(st[1])]})
    else:  # 3+ people: follow whoever is speaking
        ms, cur, hold, choice = np.zeros(n), 0, 99, []
        for i in range(a, b):
            if len(frames[i]) == n:
                ms = 0.6 * ms + 0.4 * np.array([f[4] for f in frames[i]])
            best = int(ms.argmax())
            if best != cur and ms[best] > ms[cur] * 1.3 + 0.3 and hold >= FPS:
                cur, hold = best, 0
            hold += 1
            choice.append(cur)
        r0 = 0
        for j in range(1, len(choice) + 1):
            if j == len(choice) or choice[j] != choice[r0]:
                shots.append({'t0': (a + r0) / FPS, 't1': (a + j) / FPS, 'mode': 'full', 'crops': [full(st[choice[r0]])]})
                r0 = j

shots[0]['t0'] = 0
shots[-1]['t1'] = dur
print(json.dumps({'shots': shots}))
