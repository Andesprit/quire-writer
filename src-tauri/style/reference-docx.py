#!/usr/bin/env python3
"""Makes reference.docx, the styles of every Word file the app makes with Pandoc: the look of
web/document.css in Word. Start from Pandoc's own and change the styles. Run it again after a
change: python3 src-tauri/style/reference-docx.py (needs pandoc, or quarto)."""
import io, re, shutil, subprocess, zipfile
from pathlib import Path

pandoc = ["pandoc"] if shutil.which("pandoc") else ["quarto", "pandoc"]
base = subprocess.run([*pandoc, "--print-default-data-file", "reference.docx"], capture_output=True, check=True).stdout
TEXT, SANS, MONO = "Georgia", "Helvetica Neue", "Menlo"  # Word swaps in its own when one is missing
STRONG, MUTED, ACCENT, RULE, TINT = "111418", "5B6370", "2457C5", "E3E6EA", "F5F6F8"


def fonts(face):
    return f'<w:rFonts w:ascii="{face}" w:hAnsi="{face}" w:cs="{face}" w:eastAsiaTheme="minorEastAsia" />'


def style(xml, sid, ppr="", rpr="", extra=""):
    """Replace the paragraph and run properties of style `sid` (or add the style)."""
    m = re.search(rf'<w:style [^>]*w:styleId="{sid}".*?</w:style>', xml, re.S)
    body = m.group(0)
    body = re.sub(r"<w:pPr>.*?</w:pPr>|<w:pPr ?/>", "", body, flags=re.S)
    body = re.sub(r"<w:rPr>.*?</w:rPr>|<w:rPr ?/>", "", body, flags=re.S)
    body = re.sub(r"<w:tblPr>.*?</w:tblPr>|<w:tblStylePr .*?</w:tblStylePr>", "", body, flags=re.S)
    body = body.replace("<w:semiHidden />", "")
    props = (f"<w:pPr>{ppr}</w:pPr>" if ppr else "") + (f"<w:rPr>{rpr}</w:rPr>" if rpr else "") + extra
    body = body.replace("</w:style>", props + "</w:style>")
    return xml[: m.start()] + body + xml[m.end() :]


def heading(size, before, after, color=STRONG, border=False):
    line = f'<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="{RULE}" /></w:pBdr>' if border else ""
    return (
        f'<w:keepNext /><w:keepLines />{line}<w:spacing w:before="{before}" w:after="{after}" w:line="264" w:lineRule="auto" />',
        f'{fonts(SANS)}<w:b /><w:bCs /><w:color w:val="{color}" /><w:sz w:val="{size}" /><w:szCs w:val="{size}" />',
    )


def restyle(xml):
    # Every paragraph: the book face at 11 pt, 1.3 lines apart.
    xml = re.sub(r"<w:rPrDefault>.*?</w:rPrDefault>", f'<w:rPrDefault><w:rPr>{fonts(TEXT)}<w:color w:val="1D2125" /><w:sz w:val="22" /><w:szCs w:val="22" /><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA" /></w:rPr></w:rPrDefault>', xml, flags=re.S)
    xml = re.sub(r"<w:pPrDefault>.*?</w:pPrDefault>", '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="312" w:lineRule="auto" /></w:pPr></w:pPrDefault>', xml, flags=re.S)
    xml = style(xml, "BodyText", '<w:spacing w:before="0" w:after="160" />')
    xml = style(xml, "Compact", '<w:spacing w:before="40" w:after="40" />')
    xml = style(xml, "Title", '<w:spacing w:before="0" w:after="120" w:line="240" w:lineRule="auto" />', f'{fonts(SANS)}<w:b /><w:color w:val="{STRONG}" /><w:sz w:val="52" /><w:szCs w:val="52" />')
    xml = style(xml, "Subtitle", '<w:spacing w:before="0" w:after="240" />', f'{fonts(SANS)}<w:color w:val="{MUTED}" /><w:sz w:val="28" /><w:szCs w:val="28" />')
    for sid in ("Author", "Date"):
        xml = style(xml, sid, '<w:spacing w:before="0" w:after="40" />', f'{fonts(SANS)}<w:color w:val="{MUTED}" /><w:sz w:val="20" />')
    xml = style(xml, "Heading1", *heading(36, 480, 160, border=True))
    xml = style(xml, "Heading2", *heading(28, 360, 120))
    xml = style(xml, "Heading3", *heading(24, 280, 100))
    xml = style(xml, "Heading4", *heading(22, 240, 80))
    for sid in ("Heading5", "Heading6"):
        xml = style(xml, sid, *heading(19, 220, 60, MUTED))
    xml = style(xml, "BlockText", f'<w:pBdr><w:left w:val="single" w:sz="24" w:space="10" w:color="{ACCENT}" /></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F7F9FC" /><w:spacing w:before="120" w:after="120" /><w:ind w:left="240" w:right="0" />', '<w:color w:val="3C444F" />')
    xml = style(xml, "Hyperlink", "", f'<w:color w:val="{ACCENT}" /><w:u w:val="single" w:color="A7BCE8" />')
    xml = style(xml, "VerbatimChar", "", f'{fonts(MONO)}<w:sz w:val="19" /><w:shd w:val="clear" w:color="auto" w:fill="{TINT}" />')
    for sid in ("Caption", "TableCaption", "ImageCaption"):
        xml = style(xml, sid, '<w:spacing w:before="80" w:after="200" />' + ("<w:keepNext />" if sid == "TableCaption" else "") + '<w:jc w:val="center" />', f'{fonts(SANS)}<w:color w:val="{MUTED}" /><w:sz w:val="18" />')
    xml = style(xml, "FootnoteText", "", '<w:sz w:val="18" />')
    # Tables: a sans at 10 pt, a tinted header row, quiet rules between rows.
    rule = f'w:val="single" w:sz="4" w:space="0" w:color="{RULE}"'
    box = f'w:val="single" w:sz="4" w:space="6" w:color="{RULE}"'
    xml = style(xml, "Table", "", f'{fonts(SANS)}<w:sz w:val="20" />', (
        f'<w:tblPr><w:tblInd w:w="0" w:type="dxa" /><w:tblBorders><w:bottom {rule} /><w:insideH {rule} /></w:tblBorders>'
        '<w:tblCellMar><w:top w:w="80" w:type="dxa" /><w:left w:w="140" w:type="dxa" /><w:bottom w:w="80" w:type="dxa" /><w:right w:w="140" w:type="dxa" /></w:tblCellMar></w:tblPr>'
        f'<w:tblStylePr w:type="firstRow"><w:rPr><w:b /><w:color w:val="{STRONG}" /></w:rPr><w:tcPr>'
        f'<w:tcBorders><w:bottom w:val="single" w:sz="12" w:space="0" w:color="C9CED6" /></w:tcBorders>'
        f'<w:shd w:val="clear" w:color="auto" w:fill="{TINT}" /><w:vAlign w:val="bottom" /></w:tcPr></w:tblStylePr>'
    ))
    # Not the default table style: a previewer (docx-preview) then draws the header row's look
    # on every row. Pandoc names the style on each table anyway.
    xml = re.sub(r'(<w:style w:type="table") w:default="1"( w:styleId="Table")', r"\1\2", xml)
    # The character twins of the headings and title would bring back the old font and colour.
    for sid in re.findall(r'w:styleId="((?:Heading\d|Title|Subtitle)Char)"', xml):
        xml = style(xml, sid)
    # Code blocks (Pandoc looks for this style by name).
    code = (
        '<w:style w:type="paragraph" w:customStyle="1" w:styleId="SourceCode"><w:name w:val="Source Code" /><w:basedOn w:val="Normal" /><w:link w:val="VerbatimChar" />'
        f'<w:pPr><w:pBdr><w:top {box} /><w:left {box} /><w:bottom {box} /><w:right {box} /></w:pBdr>'
        '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA" /><w:wordWrap w:val="off" /><w:spacing w:before="120" w:after="200" w:line="264" w:lineRule="auto" /><w:ind w:left="120" w:right="120" /></w:pPr>'
        f'<w:rPr>{fonts(MONO)}<w:sz w:val="19" /></w:rPr></w:style>'
    )
    return xml.replace("</w:styles>", code + "</w:styles>")


src = zipfile.ZipFile(io.BytesIO(base))
out = io.BytesIO()
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in src.infolist():
        data = src.read(item.filename)
        if item.filename == "word/styles.xml":
            data = restyle(data.decode()).encode()
        elif item.filename == "word/theme/theme1.xml":  # what "the heading font" and "the body font" mean
            theme = data.decode()
            theme = re.sub(r'(<a:majorFont>\s*<a:latin typeface=")[^"]*"( panose="[^"]*")?', rf'\g<1>{SANS}"', theme)
            theme = re.sub(r'(<a:minorFont>\s*<a:latin typeface=")[^"]*"( panose="[^"]*")?', rf'\g<1>{TEXT}"', theme)
            data = theme.encode()
        z.writestr(item, data)
Path(__file__).with_name("reference.docx").write_bytes(out.getvalue())
print("wrote", Path(__file__).with_name("reference.docx"))
