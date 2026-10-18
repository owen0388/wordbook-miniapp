教材单词表提取工具 v2 修复版

请双击“启动工具.bat”。批处理文件使用 ASCII 命令和 extractor.py，避免 Windows CMD 对中文文件名或 UTF-8 BOM 的解析问题。

也可以直接运行：
  python -m pip install -r requirements.txt
  python extractor.py

你只需要选择 PDF，并填写整个词汇表的起始页和结束页。
程序尝试从这些页面识别 Unit 标题，自动按 Unit 分组。
