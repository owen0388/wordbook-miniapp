# tools / 电子教材提取单词

从电子教材 PDF 的词汇表页提取单词，输出 xlsx。**这是词库链路的上游工具**，不在小程序运行时使用。

## 在整条链路里的位置

```
电子教材 PDF
   ↓  【本工具】教材单词表提取工具.py
xlsx（单词表）
   ↓  丢进 data/raw-src/
node scripts/xlsx2csv.mjs        ← 零依赖直读 xlsx，自动登记 books.json
   ↓
node scripts/import-wordlist.mjs ← 清洗（去 * 记号、归一括号空格）
   ↓
node scripts/build-dict.mjs      ← 生成 assets/dict/{index,units,words} + bundle.js
   ↓
小程序运行时（services/dict.js 唯一取词入口）
```

批量导入时也可以直接双击项目根目录的 `导入教材.bat`，它会串起后三步。

## 用法

双击 `启动工具.bat`（内部用 `%~dp0` 定位，迁移目录不影响）。
首次运行会自动 `pip install -r requirements.txt`。

也可以手动：

```bash
python -m pip install -r requirements.txt
python extractor.py
```

选择 PDF，填写整份词汇表的**起始页**和**结束页**。程序会从这些页识别 Unit 标题并按 Unit 分组。

## 依赖

- `pymupdf` —— PDF 解析
- `openpyxl` —— 输出 xlsx
- OCR（`pytesseract` + `Pillow`）为可选，仅在 PDF 是扫描图时才需要，已在 `requirements.txt` 中注释

## 已知约束

- 输出列需与 `data/词库导入模板.csv` 对齐，否则 `xlsx2csv.mjs` 的列映射对不上
- 本工具只负责「提取」，**不做释义清洗**，那是 `import-wordlist.mjs` 的职责
- 词条内容必须来自教材词汇表，不得凭记忆编造（项目硬规则）

## 来源

原位于 `D:\电子教材提取单词`，2026-10-19 迁入仓库统一版本管理。原目录仍保留一份。
