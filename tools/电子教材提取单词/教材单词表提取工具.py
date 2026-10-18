# -*- coding: utf-8 -*-
"""
教材单词表提取工具 v2
用户只输入整个词汇表的起始页和结束页；程序逐页提取文字，并根据 Unit 标题自动分组。
输出 Excel：总表、按识别到的 Unit 分表、逐页原文。
"""
import os
import re
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

try:
    import fitz
except ImportError:
    fitz = None
try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
except ImportError:
    Workbook = None
try:
    import pytesseract
    from PIL import Image
    import io
except ImportError:
    pytesseract = None
    Image = None
    io = None

APP_TITLE = "教材单词表提取工具 v2"

# Unit 标题识别：Unit 1 / UNIT ONE / Unit 1-2 / Starter / Review 等
UNIT_RE = re.compile(
    r"""(?ix)^\s*
    (?P<unit>
      (?:unit|module|lesson|chapter)\s*(?:no\.?\s*)?(?:\d+|[一二三四五六七八九十]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*[-–—]\s*(?:\d+|[一二三四五六七八九十]+))?
      |starter\s*\d*
      |review\s*\d*
      |revision\s*\d*
      |words?\s+and\s+expressions
    )
    \s*[:：.]?\s*$
    """
)
UNIT_INLINE_RE = re.compile(
    r"""(?ix)\b((?:unit|module|lesson|chapter)\s*(?:no\.?\s*)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*[-–—]\s*\d+)?)\b"""
)

def clean_name(s):
    return re.sub(r'[\\/:*?"<>|]+', "_", (s or "教材")).strip(" .")[:120] or "教材"

def parse_pages(s, max_page):
    s = s.strip()
    if not s:
        raise ValueError("请填写词汇表起始页和结束页。")
    nums = re.split(r"[\s,，;；\-—–]+", s)
    if len(nums) != 2 or not all(x.isdigit() for x in nums):
        raise ValueError("页码请填写两个数字，例如起始页 65、结束页 78。")
    start, end = map(int, nums)
    if start < 1 or end < start or end > max_page:
        raise ValueError(f"页码范围无效。当前 PDF 共 {max_page} 页。")
    return start, end

def normalize_text(text):
    return [re.sub(r"\s+", " ", x).strip() for x in text.replace("\r", "\n").split("\n") if x.strip()]

def detect_unit(line):
    s = re.sub(r"\s+", " ", line).strip(" \t:：")
    m = UNIT_RE.match(s)
    if m:
        return m.group("unit").strip()
    # common page text may place Unit and number in one line with other content
    m = UNIT_INLINE_RE.search(s)
    if m and len(s) <= 55:
        return m.group(1).strip()
    return None

def looks_english(s):
    return len(re.findall(r"[A-Za-z]", s)) >= 2

def looks_chinese(s):
    return bool(re.search(r"[\u4e00-\u9fff]", s))

def looks_example(s):
    return (len(s.split()) >= 4 or re.search(r"[.!?。！？]", s)) and looks_english(s)

def parse_vocab(lines, unit, page_num):
    """
    Build conservative candidate rows from lines:
    - same line with English + Chinese: split at first CJK character
    - English-only line followed by Chinese-only line: pair
    - IPA-like material is separated when recognizable
    - English example sentences are attached to a preceding entry where possible
    Original page text is saved separately for verification.
    """
    rows = []
    used = set()

    def make_row(en, zh, phon, raw):
        en = en.strip(" ：:—-·|")
        zh = zh.strip(" ：:—-·|")
        pm = re.search(r"(?:/[^/]{1,40}/|［[^］]{1,40}］|\[[^\]]{1,40}\])", en)
        if pm:
            phon = phon or pm.group(0)
            en = (en[:pm.start()] + " " + en[pm.end():]).strip()
        return {"Unit": unit, "英文": en, "中文": zh, "音标": phon, "例句": "", "页码": page_num, "原始行": raw}

    # First pass: English and Chinese in one line.
    for i, line in enumerate(lines):
        if looks_english(line) and looks_chinese(line):
            m = re.search(r"[\u4e00-\u9fff]", line)
            en, zh = line[:m.start()], line[m.start():]
            # avoid treating long instructions/paragraphs as vocabulary entries
            if en.strip() and zh.strip() and len(en) <= 90 and len(zh) <= 100:
                rows.append(make_row(en, zh, "", line))
                used.add(i)

    # Second pass: English then Chinese on separate lines.
    for i in range(len(lines)-1):
        if i in used or i+1 in used:
            continue
        a, b = lines[i], lines[i+1]
        if looks_english(a) and not looks_chinese(a) and looks_chinese(b) and not looks_english(b) and len(a) <= 90 and len(b) <= 100:
            rows.append(make_row(a, b, "", a + " / " + b))
            used.update((i, i+1))

    # Attach IPA-only lines and example sentences to the nearest previous candidate on this page.
    for i, line in enumerate(lines):
        if i in used:
            continue
        if re.fullmatch(r"[/［\[].{1,40}[/］\]]", line):
            for row in reversed(rows):
                if row["页码"] == page_num and not row["音标"]:
                    row["音标"] = line
                    break
        elif looks_example(line):
            # only attach if there is a plausible nearby word row and sentence is not a long paragraph
            if len(line) <= 180:
                for row in reversed(rows):
                    if row["页码"] == page_num and not row["例句"]:
                        row["例句"] = line
                        break
    # Drop obvious section headings accidentally parsed as entries
    return [r for r in rows if r["英文"] and r["中文"] and not detect_unit(r["英文"])]

class App:
    def __init__(self, root):
        self.root = root
        root.title(APP_TITLE)
        root.geometry("760x470")
        root.minsize(700, 430)
        self.pdf = tk.StringVar()
        self.start_page = tk.StringVar()
        self.end_page = tk.StringVar()
        self.output = tk.StringVar()
        self.ocr = tk.BooleanVar(value=False)
        self.ocr_lang = tk.StringVar(value="eng+chi_sim")
        self.status = tk.StringVar(value="选择 PDF，只填写整个词汇表范围；Unit 将从页面文字中自动识别。")
        self.build()

    def build(self):
        top = ttk.Frame(self.root, padding=12)
        top.pack(fill="x")
        ttk.Label(top, text="教材 PDF：").grid(row=0, column=0, sticky="w", pady=5)
        ttk.Entry(top, textvariable=self.pdf).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(top, text="浏览…", command=self.pick_pdf).grid(row=0, column=2)
        ttk.Label(top, text="输出 Excel：").grid(row=1, column=0, sticky="w", pady=5)
        ttk.Entry(top, textvariable=self.output).grid(row=1, column=1, sticky="ew", padx=6)
        ttk.Button(top, text="选择…", command=self.pick_output).grid(row=1, column=2)
        top.columnconfigure(1, weight=1)

        frame = ttk.LabelFrame(self.root, text="词汇表页码范围（按 PDF 页码，从 1 开始）", padding=12)
        frame.pack(fill="x", padx=12, pady=4)
        ttk.Label(frame, text="起始页：").grid(row=0, column=0, sticky="w", padx=5, pady=8)
        ttk.Entry(frame, textvariable=self.start_page, width=12).grid(row=0, column=1, sticky="w")
        ttk.Label(frame, text="结束页：").grid(row=0, column=2, sticky="w", padx=(20,5))
        ttk.Entry(frame, textvariable=self.end_page, width=12).grid(row=0, column=3, sticky="w")
        ttk.Label(frame, text="程序会扫描范围内所有页面，尝试识别 Unit 标题并按 Unit 分类。", foreground="#444").grid(row=1, column=0, columnspan=4, sticky="w", padx=5, pady=4)

        ocr_frame = ttk.LabelFrame(self.root, text="图片词汇表 / OCR（可选）", padding=10)
        ocr_frame.pack(fill="x", padx=12, pady=5)
        ttk.Checkbutton(ocr_frame, text="对没有文字层的页面启用 OCR", variable=self.ocr).grid(row=0, column=0, sticky="w")
        ttk.Label(ocr_frame, text="语言：").grid(row=0, column=1, padx=(12,2))
        ttk.Entry(ocr_frame, textvariable=self.ocr_lang, width=16).grid(row=0, column=2, sticky="w")
        ttk.Label(ocr_frame, text="需安装 Tesseract OCR 及相应语言包；普通文字型 PDF 不需要。", foreground="#666").grid(row=1, column=0, columnspan=3, sticky="w", pady=3)

        ttk.Label(self.root, text="输出包括：汇总表、自动识别的 Unit 分表、逐页原文表。复杂排版/图片识别结果需校对。", wraplength=720).pack(anchor="w", padx=14, pady=6)
        bottom = ttk.Frame(self.root, padding=12)
        bottom.pack(fill="x")
        ttk.Button(bottom, text="开始提取并生成 Excel", command=self.start).pack(side="left")
        ttk.Label(bottom, textvariable=self.status, foreground="#155eef", wraplength=500).pack(side="left", padx=12)

    def pick_pdf(self):
        p = filedialog.askopenfilename(title="选择教材 PDF", filetypes=[("PDF 文件", "*.pdf")])
        if p:
            self.pdf.set(p)
            if not self.output.get():
                self.output.set(os.path.splitext(p)[0] + "_单词表.xlsx")
            if fitz:
                try:
                    with fitz.open(p) as doc:
                        self.status.set(f"已选择 PDF，共 {len(doc)} 页。")
                except Exception:
                    pass

    def pick_output(self):
        p = filedialog.asksaveasfilename(title="保存 Excel", defaultextension=".xlsx", filetypes=[("Excel 文件", "*.xlsx")])
        if p:
            self.output.set(p)

    def start(self):
        if fitz is None or Workbook is None:
            messagebox.showerror("缺少依赖", "请运行：python -m pip install pymupdf openpyxl")
            return
        path = self.pdf.get().strip()
        out = self.output.get().strip()
        if not path or not os.path.isfile(path):
            messagebox.showerror("缺少 PDF", "请先选择有效的 PDF。")
            return
        try:
            with fitz.open(path) as doc:
                total = len(doc)
            start, end = parse_pages(f"{self.start_page.get()} {self.end_page.get()}", total)
        except Exception as e:
            messagebox.showerror("页码有误", str(e))
            return
        if not out:
            messagebox.showerror("缺少输出路径", "请选择 Excel 输出路径。")
            return
        self.status.set("正在提取文字并识别 Unit，请稍候……")
        threading.Thread(target=self.process, args=(path, out, start, end), daemon=True).start()

    def extract_page(self, doc, pnum):
        page = doc[pnum-1]
        text = page.get_text("text").strip()
        used_ocr = False
        if self.ocr.get() and len(re.sub(r"\s+", "", text)) < 8:
            if pytesseract is None or Image is None:
                raise RuntimeError("勾选了 OCR，但缺少 pytesseract/Pillow。先执行 python -m pip install pytesseract pillow，并安装 Tesseract。")
            pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            text = pytesseract.image_to_string(img, lang=self.ocr_lang.get().strip() or "eng+chi_sim")
            used_ocr = True
        return text, used_ocr

    def process(self, path, out, start, end):
        try:
            doc = fitz.open(path)
            current_unit = "未识别 Unit"
            all_rows, raw_pages = [], []
            unit_order = []
            for pnum in range(start, end+1):
                text, used_ocr = self.extract_page(doc, pnum)
                lines = normalize_text(text)
                # Scan each line for unit heading. Preserve unit state across pages.
                for line in lines:
                    detected = detect_unit(line)
                    if detected:
                        current_unit = detected
                        if current_unit not in unit_order:
                            unit_order.append(current_unit)
                rows = parse_vocab(lines, current_unit, pnum)
                all_rows.extend(rows)
                raw_pages.append((pnum, current_unit, "是" if used_ocr else "否", text))
            doc.close()

            wb = Workbook()
            headers = ["Unit", "英文", "中文", "音标", "例句", "页码", "原始行"]
            ws = wb.active
            ws.title = "单词表汇总"
            ws.append(headers)
            for r in all_rows:
                ws.append([r.get(h, "") for h in headers])
            self.style(ws)

            # Each Unit has its own sheet
            for unit in dict.fromkeys(r["Unit"] for r in all_rows):
                sheet_name = clean_name(unit)[:31]
                if sheet_name in wb.sheetnames:
                    sheet_name = (sheet_name[:25] + "_" + str(len(wb.sheetnames)))[:31]
                us = wb.create_sheet(sheet_name)
                us.append(headers)
                for r in all_rows:
                    if r["Unit"] == unit:
                        us.append([r.get(h, "") for h in headers])
                self.style(us)

            raw = wb.create_sheet("逐页原文")
            raw.append(["页码", "当前识别 Unit", "OCR 使用", "原始文字"])
            for row in raw_pages:
                raw.append(list(row))
            self.style(raw)

            guide = wb.create_sheet("说明")
            guide.append(["项目", "说明"])
            guide.append(["Unit 自动识别", "根据指定页码范围内出现的 Unit / Module / Lesson / Chapter 等标题更新当前 Unit；如果页面没有可识别标题，则归入上一 Unit 或“未识别 Unit”。"])
            guide.append(["识别准确性", "本工具使用规则匹配，不是 AI 版面理解；请用“逐页原文”检查标题识别是否正确。"])
            guide.append(["图片词汇表", "无文字层页面可选 OCR，但 OCR 需要另装 Tesseract 及语言包。"])
            guide.append(["字段", "英文、中文、音标、例句、页码、原始行。"])
            self.style(guide)
            wb.save(out)
            self.root.after(0, lambda: self.status.set(f"完成：{out}"))
            self.root.after(0, lambda: messagebox.showinfo("完成", f"已生成 Excel：\n{out}\n\n请检查“逐页原文”和 Unit 分表；如果 Unit 标题是图片，需启用 OCR 或手动校对。"))
        except Exception as e:
            msg = str(e)
            self.root.after(0, lambda: self.status.set("提取失败"))
            self.root.after(0, lambda: messagebox.showerror("提取失败", msg))

    @staticmethod
    def style(ws):
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="2F5597")
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        widths = {1:20, 2:28, 3:30, 4:20, 5:42, 6:10, 7:55, 8:80}
        for col, width in widths.items():
            ws.column_dimensions[get_column_letter(col)].width = width
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
        ws.row_dimensions[1].height = 28

def main():
    if tk is None:
        raise RuntimeError("当前 Python 环境没有 tkinter。请使用带 tkinter 的 Windows Python。")
    root = tk.Tk()
    App(root)
    root.mainloop()

if __name__ == "__main__":
    main()
