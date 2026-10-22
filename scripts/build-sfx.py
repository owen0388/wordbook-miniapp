# -*- coding: utf-8 -*-
"""
生成答题音效（构建期，一次性）
================================
输出 assets/sfx/{tap,correct,wrong,finish}.mp3

为什么要在构建期生成、而不是运行期用 Web Audio 合成：
  小程序虽然有 wx.createWebAudioContext，但：
    1) 基础库需 2.19.0+，低版本直接没有这个 API，且无法降级（真机无声）
    2) iOS 上 Web Audio 是否受系统静音开关影响没有明确文档，行为不稳定
    3) 首次创建 AudioContext 需要用户手势解锁，页面 onShow 里创建会拿到 suspended 状态
  innerAudioContext + 预置小文件是官方最稳的路径，配合 obeyMuteSwitch=false
  可以在手机静音档下依然出声。4 个文件共约 8KB，对包体积毫无压力。

音色设计（与浏览器预览版保持同一套听感）：
  tap     1046Hz 极短"哒"，音量最小 —— 只做触感确认，不参与信息表达
  pup     784→1046Hz 两声短促上滑，音量压在中档 —— 柯基被戳时的回应
          （刻意比 correct 少一个音、更低更轻，避免和"答对"混淆）
  correct 659→880→1175Hz 上行三音，像小铃铛滚下来 —— 奖励感
  wrong   311→233Hz 下行两音，三角波，刻意更轻更短 —— 答错时孩子已经紧张，不能再施压
  finish  523/659/784/1046 琶音 + 高音点缀 —— 完成感

音频参数：44.1kHz 采样合成 → ffmpeg 转 64kbps 单声道 mp3
"""

import math
import os
import struct
import subprocess
import sys
import wave

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'sfx')
TMP = os.path.join(ROOT, '.sfx-tmp')

FFMPEG = r'C:/ffmpeg-2024-12-27-git-5f38c82536-full_build/bin/ffmpeg.exe'


def blank(seconds):
    return [0.0] * int(SR * seconds)


def mix(buf, samples, at_sec, gain=1.0):
    """把 samples 叠加进 buf 的指定时间点"""
    start = int(SR * at_sec)
    for i, s in enumerate(samples):
        j = start + i
        if 0 <= j < len(buf):
            buf[j] += s * gain


def tone(freq, dur, amp=1.0, wave_type='sine', attack=0.004, decay=0.55):
    """
    单个音符：短促起音 + 指数衰减，尾部 8ms 淡出防爆音。
    decay 越小衰减越快（0.35 清脆 / 0.8 悠长）
    """
    n = int(SR * dur)
    out = []
    tau = max(0.012, dur * decay * 0.5)
    for i in range(n):
        t = i / SR
        if wave_type == 'sine':
            v = math.sin(2 * math.pi * freq * t)
        elif wave_type == 'tri':
            # 三角波 = 基频 + 奇次谐波按 1/n² 衰减，比纯正弦更"木"更柔和
            v = 0.0
            for h in (1, 3, 5):
                v += ((-1) ** ((h - 1) // 2)) * math.sin(2 * math.pi * freq * h * t) / (h * h)
            v *= 1.05
        else:
            raise ValueError(wave_type)

        a = min(1.0, t / attack) if attack > 0 else 1.0
        d = math.exp(-t / tau)
        # 尾部淡出
        tail = n - i
        if tail < int(SR * 0.008):
            d *= tail / (SR * 0.008)
        out.append(v * a * d * amp)
    return out


def click(dur=0.03, amp=0.5):
    """极短的噪声瞬态，给"哒"一点材质感，纯正弦听起来会像电子音"""
    import random
    random.seed(7)
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        d = math.exp(-t / 0.006)
        out.append((random.random() * 2 - 1) * d * amp)
    return out


def normalize(buf, peak=0.86):
    m = max((abs(x) for x in buf), default=0)
    if m < 1e-9:
        return buf
    k = peak / m
    return [x * k for x in buf]


def write_wav(path, buf):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for x in buf:
            v = int(max(-1.0, min(1.0, x)) * 32767)
            frames += struct.pack('<h', v)
        w.writeframes(bytes(frames))


def to_mp3(wav_path, mp3_path):
    cmd = [
        FFMPEG, '-y', '-loglevel', 'error',
        '-i', wav_path,
        '-ac', '1', '-ar', '44100', '-b:a', '64k',
        mp3_path,
    ]
    subprocess.run(cmd, check=True)


def build(name, buf, peak=0.86):
    wav = os.path.join(TMP, name + '.wav')
    mp3 = os.path.join(OUT, name + '.mp3')
    write_wav(wav, normalize(buf, peak))
    to_mp3(wav, mp3)
    size = os.path.getsize(mp3)
    print('  %-8s %5.0f ms  %5.1f KB' % (name, len(buf) / SR * 1000, size / 1024))
    return size


def main():
    if not os.path.isfile(FFMPEG):
        print('找不到 ffmpeg：' + FFMPEG)
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    total = 0
    print('生成音效 → assets/sfx/')

    # tap：极短一声，音量压到最低，只做触觉
    buf = blank(0.07)
    mix(buf, tone(1046.5, 0.07, amp=0.55, attack=0.001, decay=0.28), 0)
    mix(buf, click(0.028, amp=0.22), 0)
    total += build('tap', buf, peak=0.62)

    # pup：柯基被戳时的回应。两个音、更快、更轻 —— 和 correct 的三音区别开，
    # 孩子不会把"戳狗"误听成"答对了"
    buf = blank(0.26)
    mix(buf, tone(783.99, 0.09, amp=0.50, attack=0.002, decay=0.34), 0.000)
    mix(buf, tone(1046.50, 0.14, amp=0.46, decay=0.42), 0.062)
    mix(buf, click(0.02, amp=0.10), 0.000)
    total += build('pup', buf, peak=0.55)

    # correct：E5 → A5 → D6，三音上行
    buf = blank(0.42)
    mix(buf, tone(659.25, 0.16, amp=0.62, decay=0.5), 0.000)
    mix(buf, tone(880.00, 0.17, amp=0.66, decay=0.5), 0.070)
    mix(buf, tone(1174.66, 0.30, amp=0.72, decay=0.62), 0.150)
    # 高频泛音，让"叮"更透亮
    mix(buf, tone(2349.32, 0.18, amp=0.10, decay=0.4), 0.150)
    total += build('correct', buf)

    # wrong：降两音，三角波，柔和
    buf = blank(0.40)
    mix(buf, tone(311.13, 0.20, amp=0.70, wave_type='tri', decay=0.55), 0.000)
    mix(buf, tone(233.08, 0.34, amp=0.60, wave_type='tri', decay=0.65), 0.105)
    total += build('wrong', buf, peak=0.72)

    # finish：琶音 + 高音点缀
    buf = blank(1.10)
    for i, f in enumerate((523.25, 659.25, 783.99, 1046.50)):
        mix(buf, tone(f, 0.34, amp=0.55, decay=0.62), i * 0.105)
    mix(buf, tone(1567.98, 0.60, amp=0.26, decay=0.8), 0.44)
    total += build('finish', buf)

    # 清理临时 wav
    for f in os.listdir(TMP):
        os.remove(os.path.join(TMP, f))
    try:
        os.rmdir(TMP)
    except OSError:
        pass

    print('合计 %.1f KB' % (total / 1024))


if __name__ == '__main__':
    main()
