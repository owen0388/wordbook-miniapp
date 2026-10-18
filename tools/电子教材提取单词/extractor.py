# -*- coding: utf-8 -*-
"""
教材单词表提取工具 v4.0 (智能区块解析版)
特点：
1. 智能区块聚合：完美解决换行、跨行复合短语（如 gingerbread house、港珠澳大桥）；
2. 彻底过滤 Appendix 附录、页眉页脚及无效标题；
3. 精准剥离夹在中间的音标，清理 p.5 等页码，统一按 A-Z 字母排序。
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

APP_TITLE = "教材单词表提取工具 v4.0"

# openpyxl 官方的非法字符正则（XML 不允许的控制字符）
ILLEGAL_CHARACTERS_RE = re.compile(
    r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]'
)

def sanitize_for_excel(s):
    """清理 Excel 不允许写入的字符：控制字符、私有区乱码、零宽字符等"""
    if not isinstance(s, str):
        return s
    s = ILLEGAL_CHARACTERS_RE.sub('', s)          # 控制字符
    s = re.sub(r'[\ue000-\uf8ff]', '', s)          # 私有区字符（PDF 字体乱码，常显示为 □）
    s = re.sub(r'[\u200b\u200c\u200d\ufeff]', '', s)  # 零宽字符
    s = re.sub(r'\ufffd', '', s)                   # 替换符号 �
    return s.strip()

def clean_name(s):
    return re.sub(r'[\\/:*?"<>|]+', "_", (s or "教材")).strip(" .")[:120] or "教材"

def parse_pages(s, max_page):
    s = s.strip()
    if not s:
        raise ValueError("请填写词汇表起始页和结束页。")
    nums = re.split(r"[\s,$,;；\-—–]+", s)
    if len(nums) != 2 or not all(x.isdigit() for x in nums):
        raise ValueError("页码请填写两个数字，例如起始页 65、结束页 78。")
    start, end = map(int, nums)
    if start < 1 or end < start or end > max_page:
        raise ValueError(f"页码范围无效。当前 PDF 共 {max_page} 页。")
    return start, end

def normalize_text(text):
    return [re.sub(r"\s+", " ", x).strip() for x in text.replace("\r", "\n").split("\n") if x.strip()]

def clean_p_pages(text):
    """清除形如 p. 6 / p. 18, 65 / p.18、65 的页码标记及 Appendix 等杂质"""
    text = re.sub(r'\bapp(?:endix)?\s*\d*\b', '', text, flags=re.IGNORECASE)
    # p. 18, 65 / p. 18、65 / p. 18, 65, 72 —— 一次性把整组页码删掉
    text = re.sub(r'\s*p\.\s*\d+(?:\s*[，,、]\s*\d+)*\s*', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text)
    # 兜底：删掉行尾残留的孤立页码（如 ", 65" / "，65" / " 65"）
    text = re.sub(r'[，,、]\s*\d+\s*$', '', text).strip()
    text = re.sub(r'\s+\d+\s*$', '', text).strip()
    return text


def is_ignored_line(line):
    """过滤不需要的标题、页眉页脚、附录行、水印行、字母分组标题"""
    s = line.strip()
    lower = s.lower()
    if "appendix" in lower:
        return True
    if "words in each unit" in lower:
        return True
    if "vocabulary" in lower and len(lower) < 30:
        return True
    # 版权/水印行：仅供个人学习使用，未经授权不得另做他用
    if "仅供个人学习" in s or "未经授权" in s:
        return True
    # 单独一个字母（A / B / G ... 分组标题）
    if re.fullmatch(r"[A-Za-z]", s):
        return True
    # 纯数字行（残留页码）
    if re.fullmatch(r"\d+", s):
        return True
    return False


def parse_vocab_from_text(text, page_num):
    """通过智能区块聚合解析词汇表页面"""
    lines = normalize_text(text)

    # 去掉行首混入的页码，如 "65 run out 用完" -> "run out 用完"
    # 防止分组字母和第一个词挤在同一行，如 "G gala /.../ ..." -> "gala /.../ ..."
    lines = [re.sub(r"^[A-Za-z]\s+(?=[a-z])", "", l) for l in lines]

    filtered_lines = []
    for l in lines:
        if is_ignored_line(l):
            continue
        # 剥掉行首的页码/标点残渣，如 ", 65 run out" / "65 run out" / "，66 xxx"
        l = re.sub(r'^[\s\d，,、.·;；\-—–]+\s*(?=[A-Za-z*])', '', l)
        if l:
            filtered_lines.append(l)

    entries = []
    blocks = []
    current_block = []

    for line in filtered_lines:
        starts_new = False
        if current_block:
            joined = " ".join(current_block)
            has_zh = bool(re.search(r"[\u4e00-\u9fff]", joined))
            # 新词条必须是 * 或字母开头；符号/数字开头的一律是延续
            looks_like_word = bool(re.match(r"^[A-Za-z*]", line))
            if re.match(r"^\*[A-Za-z]", line):
                starts_new = True          # 带星号的新词
            elif re.match(r"^[A-Za-z]", line) and has_zh:
                starts_new = True          # 上一条已完整（出现中文），本行是新词
            # 其余情况一律视为上一条的延续（跨行英文、跨行音标、跨行中文释义）
        else:
            starts_new = True

        if starts_new:
            if current_block:
                blocks.append(" ".join(current_block))
            current_block = [line]
        else:
            current_block.append(line)

    if current_block:
        blocks.append(" ".join(current_block))

    for block in blocks:
        block = clean_p_pages(block)
        if not block or len(block) < 2:
            continue
        if "仅供个人学习" in block or "未经授权" in block:
            continue

        remark = ""
        if block.startswith("*"):
            remark = "要求必须会写"
            block = block.replace("*", " ").strip()   # 去掉块内所有星号
        block = re.sub(r"\s+", " ", block).strip()

        phon_list = re.findall(r"(?:/[^/]+?\(r\)/|/[^/]{1,60}/|［[^］]{1,50}］|\[[^\]]{1,50}\])", block)
        phon = " ".join(phon_list)

        clean_block = re.sub(r"(?:/[^/]+?\(r\)/|/[^/]{1,60}/|［[^］]{1,50}］|\[[^\]]{1,50}\])", " ", block)
        clean_block = re.sub(r"\s+", " ", clean_block).strip()

        zh_match = re.search(r"[\u4e00-\u9fff]", clean_block)
        if zh_match:
            zh_idx = zh_match.start()
            en_part = clean_block[:zh_idx].strip(" -—")
            zh_part = clean_block[zh_idx:].strip()
        else:
            en_part = clean_block
            zh_part = ""

        paren_match = re.search(r"[（\(].*", en_part)
        if paren_match:
            extra_info = clean_p_pages(en_part[paren_match.start():].strip())
            en_part = en_part[:paren_match.start()].strip()
            zh_part = f"{extra_info} {zh_part}".strip()

        # 关键修复：把音标删除后留下的空格断裂接回去
        # "Hong Kong -Zhuhai Macao Bridge" -> "Hong Kong-Zhuhai Macao Bridge"
        en_part = re.sub(r"\s*-\s*", "-", en_part)
        en_part = re.sub(r"\s+", " ", en_part).strip(" -—")
        zh_part = re.sub(r"\s+", " ", zh_part).strip()

        en_part = re.sub(r"\s+", " ", en_part.replace("*", " ")).strip(" -—")
        zh_part = re.sub(r"\s+", " ", zh_part.replace("*", " ")).strip()


        if not en_part or not zh_part:
            continue

        entries.append({
            "英文": en_part,
            "中文": zh_part,
            "音标": phon,
            "例句": "",
            "备注": remark,
            "页码": page_num,
            "原始行": block
        })
    return entries


class App:
    def __init__(self, root):
        self.root = root
        root.title(APP_TITLE)
        root.geometry("760x420")
        root.minsize(700, 380)
        self.pdf = tk.StringVar()
        self.start_page = tk.StringVar()
        self.end_page = tk.StringVar()
        self.output = tk.StringVar()
        self.ocr = tk.BooleanVar(value=False)
        self.ocr_lang = tk.StringVar(value="eng+chi_sim")
        self.status = tk.StringVar(value="选择 PDF，填写词汇表页码范围，点击开始提取。")
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

        frame = ttk.LabelFrame(self.root, text="词汇表页码范围（按 PDF 页码）", padding=12)
        frame.pack(fill="x", padx=12, pady=4)
        ttk.Label(frame, text="起始页：").grid(row=0, column=0, sticky="w", padx=5, pady=8)
        ttk.Entry(frame, textvariable=self.start_page, width=12).grid(row=0, column=1, sticky="w")
        ttk.Label(frame, text="结束页：").grid(row=0, column=2, sticky="w", padx=(20,5))
        ttk.Entry(frame, textvariable=self.end_page, width=12).grid(row=0, column=3, sticky="w")

        ocr_frame = ttk.LabelFrame(self.root, text="图片词汇表 / OCR（可选）", padding=10)
        ocr_frame.pack(fill="x", padx=12, pady=5)
        ttk.Checkbutton(ocr_frame, text="对没有文字层的页面启用 OCR", variable=self.ocr).grid(row=0, column=0, sticky="w")
        ttk.Label(ocr_frame, text="语言：").grid(row=0, column=1, padx=(12,2))
        ttk.Entry(ocr_frame, textvariable=self.ocr_lang, width=16).grid(row=0, column=2, sticky="w")

        bottom = ttk.Frame(self.root, padding=12)
        bottom.pack(fill="x")
        ttk.Button(bottom, text="开始提取并生成 Excel", command=self.start).pack(side="left")
        ttk.Label(bottom, textvariable=self.status, foreground="#155eef", wraplength=500).pack(side="left", padx=12)

    def pick_pdf(self):
        p = filedialog.askopenfilename(title="选择教材 PDF", filetypes=[("PDF 文件", "*.pdf")])
        if p:
            self.pdf.set(p)
            # 每次换 PDF 都重新生成输出文件名
            self.output.set(os.path.splitext(p)[0] + "_字母排序单词表.xlsx")
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
        self.status.set("正在智能提取并整理单词表，请稍候……")
        threading.Thread(target=self.process, args=(path, out, start, end), daemon=True).start()

    def extract_page(self, doc, pnum):
        page = doc[pnum-1]
        text = page.get_text("text").strip()
        used_ocr = False
        if self.ocr.get() and len(re.sub(r"\s+", "", text)) < 8:
            if pytesseract is None or Image is None:
                raise RuntimeError("缺少依赖：请执行 pip install pytesseract pillow")
            pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            text = pytesseract.image_to_string(img, lang=self.ocr_lang.get().strip() or "eng+chi_sim")
            used_ocr = True
        return text, used_ocr

    def process(self, path, out, start, end):
        try:
            doc = fitz.open(path)
            all_rows = []
            for pnum in range(start, end+1):
                text, _ = self.extract_page(doc, pnum)
                rows = parse_vocab_from_text(text, pnum)
                all_rows.extend(rows)
            doc.close()

            # 按英文单词首字母进行 A-Z 排序（忽略大小写）
            all_rows.sort(key=lambda x: x["英文"].lower())

            wb = Workbook()
            headers = ["英文", "中文", "音标", "例句", "备注", "页码", "原始行"]
            ws = wb.active
            ws.title = "单词表按字母排序"
            ws.append(headers)
            for r in all_rows:
                row = []
                for h in headers:
                    v = r.get(h, "")
                    row.append(sanitize_for_excel(v) if isinstance(v, str) else v)
                ws.append(row)
            self.style(ws)

            wb.save(out)
            self.root.after(0, lambda: self.status.set(f"完成：{out}"))
            self.root.after(0, lambda: messagebox.showinfo("完成", f"已成功生成干净的 Excel 单词表：\n{out}"))
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
        widths = {1:28, 2:40, 3:22, 4:35, 5:16, 6:10, 7:50}
        for col, width in widths.items():
            ws.column_dimensions[get_column_letter(col)].width = width
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
        ws.row_dimensions[1].height = 28

def main():
    if tk is None:
        raise RuntimeError("当前 Python 环境没有 tkinter。")
    root = tk.Tk()
    App(root)
    root.mainloop()

if __name__ == "__main__":
    main()