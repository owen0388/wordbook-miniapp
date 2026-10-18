# -*- coding: utf-8 -*-
"""
批量生成单词朗读音频。

链路：词库 CSV → edge-tts（微软神经语音，免费）→ ffmpeg 压到 24kHz/32kbps 单声道 + 去首尾静音
输出：assets/audio/<textbookId>/<word>.mp3

为什么用 24kHz 而不是 16kHz：
    英语的 /s/ /f/ /θ/ 等辅音能量集中在 4~10kHz，16kHz 采样（上限 8kHz）会削掉一部分，
    听感发闷、分辨度下降。24kHz 上限 12kHz，能保住这些细节，体积只多约 20%。

为什么不用微信同声传译插件：
    该插件类目为「IT科技 > 软件服务提供商」，个人主体小程序无此类目，无法添加。
    预生成 mp3 反而更好：离线可用、零配额、音质固定、不受插件审核与停服影响。

运行：python scripts/build-audio.py [--limit N] [--book pep_3a] [--force]
"""

import argparse
import asyncio
import csv
import os
import subprocess
import sys
import tempfile
import time

try:
    import edge_tts
except ImportError:
    print("缺少 edge-tts，请先运行：")
    print(r'  C:/Users/owen0/.workbuddy/binaries/python/envs/tts/Scripts/pip.exe install edge-tts -i https://pypi.org/simple')
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
OUT_DIR = os.path.join(ROOT, "assets", "audio")

FFMPEG = r"C:/ffmpeg-2024-12-27-git-5f38c82536-full_build/bin/ffmpeg.exe"

VOICE = "en-US-AriaNeural"   # 女声，吐字清晰，适合教材跟读
RATE = "-15%"                # 比常速慢 15%，小学生更容易跟

# 去首尾静音：阈值 -45dB 比较保守，避免把 about 的 /ə/ 弱起音切掉
SILENCE = (
    "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,"
    "areverse,"
    "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,"
    "areverse"
)

CONCURRENCY = 6


def audio_name(word: str) -> str:
    """单词 → 文件名。必须与小程序端 services/speech.js 的命名规则完全一致。"""
    out = []
    for ch in word.lower():
        if ch.isascii() and ch.isalnum():
            out.append(ch)
        else:
            out.append("_")
    s = "".join(out).strip("_")
    while "__" in s:
        s = s.replace("__", "_")
    return s


def load_words(only_book=None):
    """从标准词库 CSV 读词，按教材分组"""
    books = {}
    for fn in sorted(os.listdir(RAW_DIR)):
        if not fn.lower().endswith(".csv"):
            continue
        tid = fn[:-4]
        if only_book and tid != only_book:
            continue
        path = os.path.join(RAW_DIR, fn)
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        seen, words = set(), []
        for r in rows:
            w = (r.get("word") or "").strip()
            if not w:
                continue
            key = w.lower()
            if key in seen:
                continue
            seen.add(key)
            words.append(w)
        books[tid] = words
    return books


def compress(src: str, dst: str) -> bool:
    cmd = [
        FFMPEG, "-y", "-loglevel", "error",
        "-i", src,
        "-ac", "1", "-ar", "24000", "-b:a", "32k",
        "-af", SILENCE,
        "-map_metadata", "-1",
        dst,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0
    except Exception:
        return False


async def synth_one(word: str, dst: str, sem: asyncio.Semaphore, stats: dict):
    async with sem:
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(suffix=".mp3")
            os.close(fd)
            communicate = edge_tts.Communicate(word, VOICE, rate=RATE)
            await communicate.save(tmp)
            if os.path.getsize(tmp) < 100:
                raise RuntimeError("合成结果为空")
            ok = await asyncio.get_event_loop().run_in_executor(None, compress, tmp, dst)
            if not ok:
                raise RuntimeError("转码失败")
            stats["ok"] += 1
            stats["bytes"] += os.path.getsize(dst)
        except Exception as e:
            stats["fail"].append((word, str(e)[:80]))
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个词（调试用）")
    ap.add_argument("--book", default=None, help="只处理某本教材，如 pep_3a")
    ap.add_argument("--force", action="store_true", help="已存在也重新生成")
    args = ap.parse_args()

    books = load_words(args.book)
    if not books:
        print("data/raw/ 下没有词库 CSV")
        return

    total = sum(len(v) for v in books.values())
    print(f"教材 {len(books)} 本 · 待处理词条 {total}")
    print(f"语音 {VOICE} · 语速 {RATE} · 输出 {os.path.relpath(OUT_DIR, ROOT)}/")

    for tid, words in books.items():
        print(f"\n=== {tid}（{len(words)} 词）===")
        book_dir = os.path.join(OUT_DIR, tid)
        os.makedirs(book_dir, exist_ok=True)

        todo = []
        for w in words:
            name = audio_name(w)
            if not name:
                continue
            dst = os.path.join(book_dir, name + ".mp3")
            if not args.force and os.path.exists(dst) and os.path.getsize(dst) > 0:
                continue
            todo.append((w, dst))

        if args.limit:
            todo = todo[:args.limit]

        if not todo:
            print("  已全部存在，跳过")
            continue

        stats = {"ok": 0, "bytes": 0, "fail": []}
        sem = asyncio.Semaphore(CONCURRENCY)
        t0 = time.time()
        await asyncio.gather(*[synth_one(w, d, sem, stats) for w, d in todo])
        cost = time.time() - t0

        print(f"  新生成 {stats['ok']} 个 · 失败 {len(stats['fail'])} 个 · "
              f"占用 {stats['bytes']/1024:.0f} KB · 耗时 {cost:.0f}s")
        for w, e in stats["fail"][:5]:
            print(f"    ! {w} → {e}")

    # 汇总
    print("\n=== 汇总 ===")
    grand = 0
    manifest = {}
    for tid in sorted(books.keys()):
        d = os.path.join(OUT_DIR, tid)
        if not os.path.isdir(d):
            continue
        files = [f for f in os.listdir(d) if f.endswith(".mp3")]
        size = sum(os.path.getsize(os.path.join(d, f)) for f in files)
        grand += size
        # 清单里存"词"而非文件名，小程序端按同样规则换算路径
        names = set(f[:-4] for f in files)
        manifest[tid] = [w for w in books[tid] if audio_name(w) in names]
        print(f"  {tid}: {len(files):>3} 个 · {size/1024:>6.0f} KB")
    print(f"  合计 {grand/1024:.0f} KB (主包上限 2048 KB)")

    # 音频清单：小程序端据此判断某个词到底有没有音频，避免无谓的解码与报错
    manifest_path = os.path.join(OUT_DIR, "manifest.js")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/** 由 scripts/build-audio.py 生成，请勿手改 */\n")
        f.write("module.exports = ")
        import json as _json
        f.write(_json.dumps(manifest, ensure_ascii=False, sort_keys=True))
        f.write(";\n")
    print(f"  清单 {os.path.relpath(manifest_path, ROOT)} · "
          f"{sum(len(v) for v in manifest.values())} 个可用词")


if __name__ == "__main__":
    asyncio.run(main())
