#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「亂序」問答集手寫練習 PDF，並把多個版本合併成一份。

用途：對應前端 features/qa/qa-pdf.js 的「手寫練習」導出（亂序、不含答案、
附答題橫線），但可在無瀏覽器環境下用命令列一次生成多個亂序版本並合併，
方便老師一次拿到「版本 A / 版本 B」的同一份講義。

依賴：reportlab（繪製）、pypdf（合併）。未安裝時請先：
    python3 -m venv /tmp/bdcpdfvenv
    /tmp/bdcpdfvenv/bin/pip install reportlab pypdf

用法：
    /tmp/bdcpdfvenv/bin/python scripts/generate-shuffled-qa-pdf.py \
        --qa-id qa_6a_unit1_lets_give_a_hand --versions 2

預設輸出到 docs/worksheet/，檔名含 yyyyMMddHHmmssfff 時間戳。
"""

import argparse
import base64
import io
import json
import random
import time
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Flowable,
)
from pypdf import PdfWriter, PdfReader

# ===== 版面配置（語意對齊前端 features/qa/qa-pdf.js 的 PDF_CONFIG）=====
MARGIN = 20 * mm
PAGE_SIZE = A4
FONT_SIZE_TITLE = 16
FONT_SIZE_NORMAL = 12
FONT_SIZE_SMALL = 10
LEADING_NORMAL = 16
LEADING_SMALL = 13
ANSWER_LINE_GAP = 9 * mm
QUESTION_GAP = 6 * mm
COLOR_PRIMARY = (0x0F / 255, 0x76 / 255, 0x6E / 255)
COLOR_TEXT = (0x33 / 255, 0x39 / 255, 0x41 / 255)
COLOR_LINE = (120 / 255, 120 / 255, 120 / 255)

# 中文字型來源：
# 1) 系統 Arial Unicode（涵蓋完整 CJK，最保險）
# 2) 專案 Noto Sans TC 完整版（base64，跨平台）
# 3) 專案 Noto Sans TC 子集（最小，但缺「號/橫/線」等字，僅作最後備援）
FONT_CANDIDATES = [
    ("ArialUni", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
]
NOTO_BASE64 = "modules/fonts/NotoSansTC-Regular.base64.txt"
NOTO_SUBSET = "modules/fonts/NotoSansTC-Subset.ttf"

# 文案（zh-CN，對應 locales/zh-CN.js 的 qaPdf.*）
TITLE_SUFFIX = "手写练习"
VERSION_LABEL = "版本 {v}"
IDENTITY = "日期：_______________    姓名：_______________    成绩：_______________"
INSTRUCTIONS = "说明：请在横线上写出完整的英文答案，注意大小写和标点符号。"
FOOTER = "第 {current} 页，共 {total} 页"


def register_font(root):
    for name, path in FONT_CANDIDATES:
        p = Path(path)
        if p.exists():
            pdfmetrics.registerFont(TTFont(name, str(p)))
            return name

    # 從 base64 還原完整 Noto Sans TC
    b64_path = root / NOTO_BASE64
    if b64_path.exists():
        ttf_path = Path("/tmp/NotoSansTC-Regular.ttf")
        if not ttf_path.exists():
            ttf_path.write_bytes(base64.b64decode(b64_path.read_text(encoding="utf-8").strip()))
        pdfmetrics.registerFont(TTFont("NotoSansTC", str(ttf_path)))
        return "NotoSansTC"

    subset = root / NOTO_SUBSET
    if subset.exists():
        pdfmetrics.registerFont(TTFont("NotoSansTC-Subset", str(subset)))
        return "NotoSansTC-Subset"
    raise RuntimeError("找不到可用的中文字型（Arial Unicode / Noto Sans TC）")


class AnswerLines(Flowable):
    """固定行數的答題橫線。"""

    def __init__(self, count, width, gap=ANSWER_LINE_GAP):
        super().__init__()
        self.count = count
        self.width = width
        self.gap = gap
        self.height = count * gap

    def draw(self):
        c = self.canv
        c.setStrokeColorRGB(*COLOR_LINE)
        c.setLineWidth(0.3)
        x0, x1 = 5 * mm, self.width - 5 * mm
        for i in range(self.count):
            y = self.height - (i + 1) * self.gap
            c.line(x0, y, x1, y)


def build_version_pdf(path, font_name, qa_name, questions, version_label, answer_lines):
    """產生單一亂序版本 PDF（自動分頁、每頁頁腳含頁碼）。"""
    title_style = ParagraphStyle(
        "title", fontName=font_name, fontSize=FONT_SIZE_TITLE, leading=FONT_SIZE_TITLE * 1.3,
        textColor=COLOR_PRIMARY, spaceAfter=2,
    )
    small_style = ParagraphStyle(
        "small", fontName=font_name, fontSize=FONT_SIZE_SMALL, leading=LEADING_SMALL,
        textColor=COLOR_TEXT,
    )
    q_style = ParagraphStyle(
        "q", fontName=font_name, fontSize=FONT_SIZE_NORMAL, leading=LEADING_NORMAL,
        textColor=COLOR_TEXT,
    )

    title_text = f"{qa_name} - {TITLE_SUFFIX}"
    if version_label:
        title_text += f"（{version_label}）"

    def make_story():
        story = [
            Paragraph(title_text, title_style),
            Spacer(1, 4 * mm),
            Paragraph(IDENTITY, small_style),
            Spacer(1, 2 * mm),
            Paragraph(INSTRUCTIONS, small_style),
            Spacer(1, 6 * mm),
        ]
        for idx, q in enumerate(questions, start=1):
            story.append(Paragraph(f"{idx}. {_escape(q['question'])}", q_style))
            story.append(Spacer(1, ANSWER_LINE_GAP))
            story.append(AnswerLines(answer_lines, PAGE_SIZE[0] - 2 * MARGIN))
            story.append(Spacer(1, QUESTION_GAP))
        return story

    # 第一趟：先跑一次取得總頁數
    counter = {"max": 0}

    def count_page(c, doc):
        counter["max"] = max(counter["max"], doc.page)

    probe = BaseDocTemplate(
        io.BytesIO(), pagesize=PAGE_SIZE,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN,
    )
    probe.addPageTemplates([PageTemplate(
        id="p",
        frames=[Frame(MARGIN, MARGIN, PAGE_SIZE[0] - 2 * MARGIN,
                      PAGE_SIZE[1] - 2 * MARGIN, id="f")],
        onPage=count_page)])
    probe.build(make_story())
    total_pages = max(counter["max"], 1)

    def draw_footer(c, doc):
        c.setFont(font_name, FONT_SIZE_SMALL)
        c.setFillColorRGB(*COLOR_TEXT)
        c.drawCentredString(PAGE_SIZE[0] / 2, 10 * mm,
                            FOOTER.format(current=doc.page, total=total_pages))

    doc = BaseDocTemplate(
        str(path), pagesize=PAGE_SIZE,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN,
    )
    doc.addPageTemplates([PageTemplate(
        id="p", frames=[Frame(MARGIN, MARGIN, PAGE_SIZE[0] - 2 * MARGIN,
                              PAGE_SIZE[1] - 2 * MARGIN, id="f")],
        onPage=draw_footer)])
    doc.build(make_story())


def _escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def shuffled_orders(n, versions, rng):
    """產生 versions 個排列：互不相同、非原始順序，且首題盡量互異。"""
    original = list(range(n))
    orders, guard = [], 0
    while len(orders) < versions and guard < 100000:
        guard += 1
        perm = original[:]
        rng.shuffle(perm)
        if perm == original or any(perm == e for e in orders):
            continue
        if perm[0] in {o[0] for o in orders}:
            continue
        orders.append(perm)
    # 若首題無法再互異，放寬條件補足
    while len(orders) < versions and guard < 200000:
        guard += 1
        perm = original[:]
        rng.shuffle(perm)
        if perm != original and not any(perm == e for e in orders):
            orders.append(perm)
    if len(orders) < versions:
        print(f"警告：題目數 {n} 無法產生 {versions} 個互異排列，實際產生 {len(orders)} 個")
    return orders


def main():
    ap = argparse.ArgumentParser(description="生成亂序問答手寫練習 PDF 並合併")
    ap.add_argument("--qa-id", required=True, help="問答集 id，例如 qa_6a_unit1_lets_give_a_hand")
    ap.add_argument("--versions", type=int, default=2, help="亂序版本數（預設 2）")
    ap.add_argument("--answer-lines", type=int, default=2, help="每題答題線數（預設 2）")
    ap.add_argument("--out-dir", default="docs/worksheet")
    ap.add_argument("--seed", type=int, default=None, help="亂序種子（預設用時間）")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    qa_path = root / "qa-sets" / f"{args.qa_id}.json"
    if not qa_path.exists():
        raise SystemExit(f"找不到問答集：{qa_path}")
    qa = json.loads(qa_path.read_text(encoding="utf-8"))
    questions = qa["questions"]
    if len(questions) < 2:
        raise SystemExit("題目少於 2 題，無法亂序")

    font_name = register_font(root)
    rng = random.Random(args.seed)
    orders = shuffled_orders(len(questions), args.versions, rng)

    out_dir = root / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"

    version_files = []
    for v, order in enumerate(orders):
        label = VERSION_LABEL.format(v=chr(ord("A") + v))
        ordered = [questions[i] for i in order]
        final = out_dir / f"{ts}_{args.qa_id}_{TITLE_SUFFIX}_乱序_{label}.pdf"
        build_version_pdf(final, font_name, qa["name"], ordered, label, args.answer_lines)
        version_files.append(final)
        print(f"版本 {label}：{final.name}")
        print("    題序：" + " → ".join(str(i + 1) for i in order))

    if len(version_files) > 1:
        merged = out_dir / f"{ts}_{args.qa_id}_{TITLE_SUFFIX}_乱序_合并版.pdf"
        writer = PdfWriter()
        for f in version_files:
            for page in PdfReader(str(f)).pages:
                writer.add_page(page)
        with open(merged, "wb") as fh:
            writer.write(fh)
        print(f"合併完成：{merged}")
    else:
        merged = version_files[0]

    return str(merged)


if __name__ == "__main__":
    main()
