"""Finds each club member's eyes and mouth in the Avatars file and writes FacePoints.gs.

Usage: python face_points.py <Avatars.html> <face_landmarker.task> <out FacePoints.gs>

Runs in the Deploy to Apps Script job. The photos come from the private
AVATARS_HTML secret and are never saved anywhere else; only the positions below
are written, in photo units from 0 (left/top) to 100 (right/bottom), which match
the 0 to 100 drawing box the app lays over each round photo.

  l, r   just under the lower eyelid of the eye on the left / right of the photo
  ew     eye width
  m      middle of the mouth, mw mouth width
  roll   head tilt in degrees (positive = right side of the photo lower)

A member whose face isn't found is left out, and the app falls back to its
default spots for them.
"""
import base64
import io
import json
import math
import re
import sys

import numpy as np
from PIL import Image

import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

# MediaPipe face mesh points
EYE_A = {'outer': 33, 'inner': 133, 'upper': 159, 'lower': 145}
EYE_B = {'inner': 362, 'outer': 263, 'upper': 386, 'lower': 374}
MOUTH_L, MOUTH_R, LIP_TOP, LIP_BOTTOM = 61, 291, 13, 14


def photos(text):
    out = {}
    for m in re.finditer(r"[\"']?([A-Za-z][\w ]*)[\"']?\s*:\s*[\"'](data:image/[^\"']+)[\"']", text):
        out[m.group(1).strip()] = m.group(2)
    return out


def decode(data_url):
    raw = base64.b64decode(data_url.split(',', 1)[1])
    im = Image.open(io.BytesIO(raw)).convert('RGB')
    return im


def find(landmarker, im):
    """Landmarks for the biggest face, trying a few sizes (small photos detect better upscaled)."""
    w, h = im.size
    for scale in (1, 3, 2, 4):
        big = im.resize((w * scale, h * scale), Image.LANCZOS) if scale > 1 else im
        res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(big)))
        if res.face_landmarks:
            return res.face_landmarks[0]
    return None


def points(lm, w, h):
    # Landmarks are 0..1 of the image; the app's box is the square photo shown with
    # object-fit: cover, so for a non square photo crop to the centered square.
    side = min(w, h)
    ox, oy = (w - side) / 2.0, (h - side) / 2.0

    def p(i):
        return ((lm[i].x * w - ox) / side * 100.0, (lm[i].y * h - oy) / side * 100.0)

    def eye(e):
        o, n, up, lo = p(e['outer']), p(e['inner']), p(e['upper']), p(e['lower'])
        width = math.dist(o, n)
        opening = math.dist(up, lo)
        # start the tear just below the lower lid
        return {'x': lo[0], 'y': lo[1] + max(1.0, opening * 0.35), 'w': width, 'c': ((o[0] + n[0]) / 2, (o[1] + n[1]) / 2)}

    a, b = eye(EYE_A), eye(EYE_B)
    left, right = (a, b) if a['x'] <= b['x'] else (b, a)
    roll = math.degrees(math.atan2(right['c'][1] - left['c'][1], right['c'][0] - left['c'][0]))
    ml, mr, lt, lb = p(MOUTH_L), p(MOUTH_R), p(LIP_TOP), p(LIP_BOTTOM)
    r1 = lambda v: round(v, 1)
    return {
        'l': [r1(left['x']), r1(left['y'])],
        'r': [r1(right['x']), r1(right['y'])],
        'ew': r1((left['w'] + right['w']) / 2),
        'm': [r1((lt[0] + lb[0]) / 2), r1((lt[1] + lb[1]) / 2)],
        'mw': r1(math.dist(ml, mr)),
        'roll': r1(roll),
    }


def main():
    src, model, out = sys.argv[1], sys.argv[2], sys.argv[3]
    pics = photos(open(src, encoding='utf-8').read())
    opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model), num_faces=1)
    result = {}
    with vision.FaceLandmarker.create_from_options(opts) as landmarker:
        for name, url in sorted(pics.items()):
            try:
                im = decode(url)
                lm = find(landmarker, im)
            except Exception as e:  # a bad photo shouldn't stop the deploy
                print('::warning title=Face points::%s: could not read the photo (%s)' % (name, e))
                continue
            if lm is None:
                print('::warning title=Face points::%s: no face found, the app will use its default spots' % name)
                continue
            result[name] = points(lm, *im.size)
            print('%s: %s' % (name, json.dumps(result[name])))
    with open(out, 'w', encoding='utf-8') as f:
        f.write('/**\n * Written by the Deploy to Apps Script job (MediaPipe Face Landmarker on the club\n'
                ' * photos). Where each member\'s eyes and mouth sit on their photo, 0 to 100.\n'
                ' * Do not edit: it is rebuilt on every deploy. See .github/scripts/face_points.py.\n */\n')
        f.write('var AD_FACE_POINTS = ' + json.dumps(result, sort_keys=True) + ';\n')
    print('Faces found: %d of %d photos' % (len(result), len(pics)))


if __name__ == '__main__':
    main()
