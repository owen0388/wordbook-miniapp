# -*- coding: utf-8 -*-
import os

root = r'D:\电子教材提取单词'
print('exists:', os.path.isdir(root))
if not os.path.isdir(root):
    import glob
    for p in glob.glob('D:/*'):
        if '教材' in p or '单词' in p:
            print('candidate:', p)
    raise SystemExit

total = 0
count = 0
dirs = []
for dirpath, dirnames, filenames in os.walk(root):
    depth = dirpath[len(root):].count(os.sep)
    for f in filenames:
        fp = os.path.join(dirpath, f)
        try:
            sz = os.path.getsize(fp)
        except OSError:
            continue
        total += sz
        count += 1
        if depth <= 1:
            dirs.append((os.path.relpath(fp, root), sz))

print('total files: %d, size: %.2f MB' % (count, total / 1048576.0))
print()
print('--- top level files ---')
dirs.sort(key=lambda x: -x[1])
for name, sz in dirs[:40]:
    print('%10.1f KB  %s' % (sz / 1024.0, name))

print()
print('--- immediate subdirs ---')
for d in sorted(os.listdir(root)):
    p = os.path.join(root, d)
    if os.path.isdir(p):
        n = sum(len(fs) for _, _, fs in os.walk(p))
        s = 0
        for dp, _, fs in os.walk(p):
            for f in fs:
                try:
                    s += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass
        print('%10.2f MB  %s/  (%d files)' % (s / 1048576.0, d, n))
