import json
import numpy as np
import sys
import os

def compute_jerk(path):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    coords = np.array([[d['x'], d['y']] for d in data])
    if len(coords) < 4:
        return None, len(coords)
    jerk = np.mean(np.abs(np.diff(coords, n=3, axis=0)))
    return jerk, len(coords)

if __name__ == '__main__':
    folder = sys.argv[1] if len(sys.argv) > 1 else '.'
    results = {}
    for fname in sorted(os.listdir(folder)):
        if not fname.endswith('.json'):
            continue
        path = os.path.join(folder, fname)
        jerk, n = compute_jerk(path)
        if jerk is None:
            print(f'{fname}: 帧数不足 ({n})')
            continue
        print(f'{fname}: frames={n}, jerk={jerk:.6f}')
        key = fname.rsplit('-', 1)[0]
        results.setdefault(key, []).append(jerk)

    print('\n按轨迹平均：')
    for key, vals in results.items():
        print(f'{key}: jerk_avg={np.mean(vals):.6f} (n={len(vals)})')