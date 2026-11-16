// Минимальная запись .xlsx без библиотек: несколько листов, строки и числа, ширина колонок, объединение
// ячеек, закреплённая шапка и десяток готовых стилей. Архив без сжатия (STORE) — Excel, «Р7» и LibreOffice
// открывают его как обычный файл; график пункта весит десятки килобайт.

export type CellStyle = "plain" | "title" | "note" | "head" | "cell" | "center" | "num" | "bold" | "boldNum" | "weekend" | "shift" | "sub" | "owner";
export type CellValue = string | number | null | undefined;
export type Cell = CellValue | { v: CellValue; s?: CellStyle };

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** ширина колонок в символах */
  cols?: number[];
  /** "A1:F1" */
  merges?: string[];
  /** закрепить строки сверху и колонки слева */
  freeze?: { rows: number; cols: number };
}

const STYLE_INDEX: Record<CellStyle, number> = {
  plain: 0, title: 1, note: 2, head: 3, cell: 4, center: 5, num: 6, bold: 7, boldNum: 8, weekend: 9, shift: 10, sub: 11, owner: 12,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF5F5F6D"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEBEBEF"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF4F4F7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFEAFC"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE6EFFD"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE9EAF0"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD3D3DC"/></left><right style="thin"><color rgb="FFD3D3DC"/></right><top style="thin"><color rgb="FFD3D3DC"/></top><bottom style="thin"><color rgb="FFD3D3DC"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
</styleSheet>`;

function esc(s: string): string {
  // управляющие символы недопустимы в XML 1.0
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colName(i: number): string {
  let n = i + 1, out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(sheet: Sheet): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  if (sheet.freeze && (sheet.freeze.rows || sheet.freeze.cols)) {
    const { rows, cols } = sheet.freeze;
    const ref = `${colName(cols)}${rows + 1}`;
    const pane = rows && cols ? "bottomRight" : rows ? "bottomLeft" : "topRight";
    parts.push(`<sheetViews><sheetView workbookViewId="0"><pane${cols ? ` xSplit="${cols}"` : ""}${rows ? ` ySplit="${rows}"` : ""} topLeftCell="${ref}" activePane="${pane}" state="frozen"/></sheetView></sheetViews>`);
  }
  if (sheet.cols?.length) {
    parts.push("<cols>");
    sheet.cols.forEach((w, i) => parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
    parts.push("</cols>");
  }
  parts.push("<sheetData>");
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((raw, c) => {
      const cell = raw !== null && typeof raw === "object" ? raw : { v: raw };
      const ref = `${colName(c)}${r + 1}`;
      const s = STYLE_INDEX[cell.s ?? "plain"];
      const sAttr = s ? ` s="${s}"` : "";
      if (cell.v === null || cell.v === undefined || cell.v === "") {
        if (s) cells.push(`<c r="${ref}"${sAttr}/>`);
      } else if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
        cells.push(`<c r="${ref}"${sAttr}><v>${cell.v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`);
      }
    });
    parts.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  parts.push("</sheetData>");
  if (sheet.merges?.length) parts.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`);
  parts.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  parts.push('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  parts.push("</worksheet>");
  return parts.join("");
}

/** Имя листа: до 31 символа, без []:*?/\ и неповторяющееся. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let base = s.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Лист ${i + 1}`;
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${n++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function xlsxFiles(sheets: Sheet[]): Record<string, string> {
  const names = sheetNames(sheets);
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES_XML,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
  return files;
}

// ---------- zip (STORE) ----------

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStore(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const entries = Object.entries(files).map(([name, text]) => ({ name: enc.encode(name), data: enc.encode(text) }));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1 января 2026, 00:00 — время в архиве ни на что не влияет
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // имена в UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, e.name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), e.name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, e.name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((a, c) => a + c.length, 0)));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function writeXlsx(sheets: Sheet[]): Uint8Array<ArrayBuffer> {
  return zipStore(xlsxFiles(sheets));
}
