# -*- coding: utf-8 -*-
"""把带背景的吉祥物插画抠成透明底 PNG（构建期工具，一次性的活）

用法：
    python scripts/matte-mascot.py 源图.png [输出.png]

默认输出 assets/images/mascot-corgi.png。

为什么不用现成的抠图库：
  1) 这类插画的背景是近白纸纹，狗身也是暖白 —— rembg 之类的模型会把
     狗的白色胸腹一起抠掉（它按"显著前景"判断，不看连通性）
  2) 我们只需要一条可复现、可调参的流水线，跑三次结果一样，不引入
     onnxruntime 这种几百 MB 的依赖

算法三步：
  ① 从四边泛洪，只把「和边界连通、且近似背景色」的像素算背景。
     狗身的同色区域被深色轮廓包住，泛洪进不去 —— 靠连通性而不是纯色差。
  ② 底部 26px 单独再泛洪一遍，条件放宽到亮度 > 205。
     狗身下的投影颜色和毛色几乎重合，色差法切不掉；但它只出现在底部一条带里，
     放宽后能清掉，爪子被自己的深色轮廓挡着不会误伤。
  ③ 向外膨胀 1px 再羽化，吃掉边缘"背景与主体混色"的过渡色（否则贴到
     别的底色上会有一圈浅色描边）。

最后加 2px 白描边做成模切贴纸 —— 全站 .sticker 文字也是这套白描边。
"""
import collections
import os
import sys

from PIL import Image, ImageFilter

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'assets', 'images', 'mascot-corgi.png'
)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src_path = sys.argv[1]
    dst_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

    im = Image.open(src_path).convert('RGBA')
    w, h = im.size
    px = im.load()

    # 背景色取四角里最亮的那个（纸纹背景通常是近白，四角会略有明暗差）
    corners = [px[0, 0][:3], px[w - 1, 0][:3], px[0, h - 1][:3], px[w - 1, h - 1][:3]]
    bg = max(corners, key=lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
    tol = 18
    print('尺寸 %dx%d，背景色 %s' % (w, h, bg))

    def luma(c):
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

    def near_bg(c):
        return all(abs(c[i] - bg[i]) <= tol for i in range(3))

    def flood(pred, seeds, keep=None):
        seen = bytearray(w * h)
        q = collections.deque()

        def push(x, y):
            if not (0 <= x < w and 0 <= y < h):
                return
            if keep and not keep(x, y):
                return
            i = y * w + x
            if seen[i]:
                return
            if pred(px[x, y]):
                seen[i] = 1
                q.append((x, y))

        for s in seeds:
            push(*s)
        while q:
            x, y = q.popleft()
            push(x - 1, y)
            push(x + 1, y)
            push(x, y - 1)
            push(x, y + 1)
        return seen

    edge = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)]
    edge += [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    bg1 = flood(near_bg, edge)

    band = h - 26
    band_seeds = [(x, h - 1) for x in range(w)]
    band_seeds += [(0, y) for y in range(band, h)] + [(w - 1, y) for y in range(band, h)]
    bg2 = flood(lambda c: luma(c) > 205, band_seeds, keep=lambda x, y: y >= band)

    drop = sum(1 for i in range(w * h) if bg2[i] and not bg1[i])
    print('背景 %d px，另清掉底部投影 %d px' % (sum(bg1), drop))

    mask = Image.new('L', (w, h), 0)
    mask.putdata([255 if (bg1[i] or bg2[i]) else 0 for i in range(w * h)])
    mask = mask.filter(ImageFilter.MaxFilter(3))
    mask = mask.filter(ImageFilter.GaussianBlur(0.55))

    out = im.copy()
    out.putalpha(mask.point(lambda v: 255 - v))

    # 2px 白色贴纸边
    a = out.split()[3]
    grow = a.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(0.4))
    back = Image.new('RGBA', (w, h), (255, 255, 255, 0))
    back.putalpha(grow)
    out = Image.alpha_composite(back, out).crop(Image.alpha_composite(back, out).getbbox())

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    out.save(dst_path, optimize=True)
    print('输出 %s  %dx%d  %d KB' % (dst_path, out.width, out.height,
                                    os.path.getsize(dst_path) // 1024))


if __name__ == '__main__':
    main()
