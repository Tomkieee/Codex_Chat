import { DEJAVU_SANS_BASE64 } from "./font-data.js";

// Worker: generuje PDF z wykresem H(Q) i jedną parą podpisów: "Q [m3/h] ", "2 pompy", "3 pompy" (bez x2/x3).

/* ===== Helpers ===== */
const enc = new TextEncoder();
function b(s){ return enc.encode(s); }

// Jeśli chcesz zawsze dołączać konkretny szablon PDF z brandingiem,
// wpisz jego publiczny adres tutaj. Zostanie dodany do payloadu jako
// `branding.templateUrl`, nawet jeśli formularz /test pozostanie pusty.
const STATIC_BRAND_TEMPLATE_URL = "";

function isFiniteNumber(v){ return typeof v === "number" && Number.isFinite(v); }
function clamp01(v){ return Math.min(1, Math.max(0, v)); }
function clamp(v, min, max){ return Math.min(Math.max(v, min), max); }

function parseColor(value, fallback){
  if (Array.isArray(value) && value.length === 3) {
    const parts = value.map(Number).map(v => (Number.isFinite(v) ? v : 0));
    const needsNormalize = parts.some(v => v > 1);
    const normalized = parts.map(v => clamp01(needsNormalize ? v / 255 : v));
    return normalized;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    const match = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (match) {
      let hex = match[1];
      if (hex.length === 3) hex = hex.split("").map(ch => ch + ch).join("");
      const r = parseInt(hex.slice(0,2),16) / 255;
      const g = parseInt(hex.slice(2,4),16) / 255;
      const b = parseInt(hex.slice(4,6),16) / 255;
      return [clamp01(r), clamp01(g), clamp01(b)];
    }
  }
  return Array.isArray(fallback) ? fallback : [0,0,0];
}

function colorCmd(rgb, op){
  const parts = (Array.isArray(rgb) && rgb.length === 3 ? rgb : [0,0,0]).map(v => clamp01(Number(v) || 0));
  return `${parts.map(v => v.toFixed(3)).join(" ")} ${op}`;
}

function autoTextColor(bg){
  if (!Array.isArray(bg) || bg.length !== 3) return [1,1,1];
  const [r,g,b] = bg;
  const luminance = 0.299*r + 0.587*g + 0.114*b;
  return luminance > 0.55 ? [0.12,0.12,0.12] : [1,1,1];
}

/* ===== Font helpers ===== */
const FONT_NAME = "DejaVuSans";
const FONT_DATA = base64ToUint8(DEJAVU_SANS_BASE64);
const FONT_INFO = parseTrueTypeFont(FONT_DATA, FONT_NAME);

function createPDFTextEncoder(usedGlyphs){
  const target = usedGlyphs instanceof Set ? usedGlyphs : null;
  if (target) {
    target.add(FONT_INFO.fallbackGlyph);
    target.add(0);
  }
  return function encodeForPDF(input){
    const str = String(input ?? "").replace(/\r?\n/g, " ");
    if (!str) return "<>";
    const glyphs = [];
    for (const ch of str) {
      const code = ch.codePointAt(0);
      const glyph = FONT_INFO.codeToGlyph.get(code) ?? FONT_INFO.fallbackGlyph;
      glyphs.push(glyph);
      if (target) target.add(glyph);
    }
    if (!glyphs.length) return "<>";
    const hex = glyphs.map(g => g.toString(16).padStart(4, "0")).join("");
    return `<${hex}>`;
  };
}

function base64ToUint8(base64){
  const clean = String(base64 || "").replace(/\s+/g, "");
  if (typeof atob === "function") {
    const binary = atob(clean);
    const len = binary.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const buf = Buffer.from(clean, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseTrueTypeFont(data, fontName){
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = view.getUint16(4);
  const tables = {};
  let ptr = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(view.getUint8(ptr), view.getUint8(ptr + 1), view.getUint8(ptr + 2), view.getUint8(ptr + 3));
    const offset = view.getUint32(ptr + 8);
    const length = view.getUint32(ptr + 12);
    tables[tag] = { offset, length };
    ptr += 16;
  }

  function requireTable(tag){
    const entry = tables[tag];
    if (!entry) throw new Error(`Brak wymaganego bloku TTF: ${tag}`);
    return entry;
  }

  const head = requireTable("head");
  const hhea = requireTable("hhea");
  const maxp = requireTable("maxp");
  const hmtx = requireTable("hmtx");
  const cmap = requireTable("cmap");

  const unitsPerEm = view.getUint16(head.offset + 18);
  const xMin = view.getInt16(head.offset + 36);
  const yMin = view.getInt16(head.offset + 38);
  const xMax = view.getInt16(head.offset + 40);
  const yMax = view.getInt16(head.offset + 42);

  const ascenderHhea = view.getInt16(hhea.offset + 4);
  const descenderHhea = view.getInt16(hhea.offset + 6);
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);

  const numGlyphs = view.getUint16(maxp.offset + 4);
  const advanceWidths = new Array(numGlyphs);
  let pos = hmtx.offset;
  for (let i = 0; i < numberOfHMetrics; i++) {
    advanceWidths[i] = view.getUint16(pos);
    pos += 4;
  }
  const lastWidth = advanceWidths[numberOfHMetrics - 1] ?? unitsPerEm;
  for (let i = numberOfHMetrics; i < numGlyphs; i++) advanceWidths[i] = lastWidth;

  let typoAscender = ascenderHhea;
  let typoDescender = descenderHhea;
  let capHeight = ascenderHhea * 0.7;
  let weightClass = 400;

  const os2 = tables["OS/2"];
  if (os2) {
    const base = os2.offset;
    const length = os2.length;
    const version = view.getUint16(base);
    if (length >= 6) weightClass = view.getUint16(base + 4);
    if (length >= 72) {
      const asc = view.getInt16(base + 68);
      const desc = view.getInt16(base + 70);
      if (asc) typoAscender = asc;
      if (desc) typoDescender = desc;
    }
    if (version >= 2 && length >= 90) {
      const cap = view.getInt16(base + 88);
      if (cap) capHeight = cap;
    } else if (length >= 78) {
      const winAsc = view.getUint16(base + 74);
      const winDesc = view.getUint16(base + 76);
      if (winAsc) typoAscender = winAsc;
      if (winDesc) typoDescender = -winDesc;
    }
  }

  const post = tables.post;
  let italicAngle = 0;
  if (post) italicAngle = view.getInt32(post.offset + 4) / 65536;

  const cmapData = parseCmap(view, cmap.offset, cmap.length, numGlyphs);
  const fallbackGlyph = cmapData.codeToGlyph.get(63) ?? cmapData.codeToGlyph.get(32) ?? 0;
  const spaceGlyph = cmapData.codeToGlyph.get(32);
  const defaultWidth = spaceGlyph != null ? advanceWidths[spaceGlyph] : unitsPerEm / 2;
  const stemV = Math.max(50, (weightClass || 400) / 5);

  return {
    name: fontName,
    unitsPerEm,
    ascender: typoAscender,
    descender: typoDescender,
    capHeight,
    bbox: [xMin, yMin, xMax, yMax],
    italicAngle,
    advanceWidths,
    glyphCount: numGlyphs,
    codeToGlyph: cmapData.codeToGlyph,
    glyphToCode: cmapData.glyphToCode,
    fallbackGlyph,
    defaultWidth,
    stemV
  };
}

function parseCmap(view, offset, length, glyphCount){
  const numTables = view.getUint16(offset + 2);
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < numTables; i++) {
    const platformID = view.getUint16(offset + 4 + i * 8);
    const encodingID = view.getUint16(offset + 6 + i * 8);
    const subOffset = view.getUint32(offset + 8 + i * 8);
    const absolute = offset + subOffset;
    const format = view.getUint16(absolute);
    if (format !== 4 && format !== 12) continue;
    const score = cmapPreference(platformID, encodingID, format);
    if (score > bestScore) {
      bestScore = score;
      best = { format, offset: absolute };
    }
  }
  if (!best) throw new Error("Brak obsługiwanego formatu cmap w czcionce");

  const entries = new Map();
  if (best.format === 4) parseCmapFormat4(view, best.offset, entries);
  else parseCmapFormat12(view, best.offset, entries);

  const codeToGlyph = new Map();
  const glyphToCode = new Array(Math.max(0, glyphCount || 0)).fill(null);
  for (const [code, glyph] of entries) {
    if (glyph == null) continue;
    codeToGlyph.set(code, glyph);
    if (glyph >= 0 && (glyphToCode[glyph] == null || glyphToCode[glyph] > code)) {
      glyphToCode[glyph] = code;
    }
  }
  return { codeToGlyph, glyphToCode };
}

function cmapPreference(platform, encoding, format){
  let base = 0;
  if (platform === 3 && encoding === 10) base = 4;
  else if (platform === 0 && encoding === 4) base = 3;
  else if (platform === 3 && encoding === 1) base = 2;
  else if (platform === 0 && (encoding === 3 || encoding === 1 || encoding === 0)) base = 2;
  else if (platform === 3 && encoding === 0) base = 1;
  if (format === 12) base += 0.5;
  return base;
}

function parseCmapFormat4(view, offset, out){
  const tableLength = view.getUint16(offset + 2);
  const tableEnd = offset + tableLength;
  const segCount = view.getUint16(offset + 6) / 2;
  let pos = offset + 14;
  const endCount = new Array(segCount);
  for (let i = 0; i < segCount; i++) { endCount[i] = view.getUint16(pos); pos += 2; }
  pos += 2; // reservedPad
  const startCount = new Array(segCount);
  for (let i = 0; i < segCount; i++) { startCount[i] = view.getUint16(pos); pos += 2; }
  const idDelta = new Array(segCount);
  for (let i = 0; i < segCount; i++) { idDelta[i] = view.getInt16(pos); pos += 2; }
  const idRangeOffsetPos = pos;
  const idRangeOffset = new Array(segCount);
  for (let i = 0; i < segCount; i++) { idRangeOffset[i] = view.getUint16(pos); pos += 2; }

  for (let i = 0; i < segCount; i++) {
    const start = startCount[i];
    const end = endCount[i];
    if (start === 0xFFFF && end === 0xFFFF) continue;
    const delta = idDelta[i];
    const rangeOffset = idRangeOffset[i];
    for (let code = start; code <= end; code++) {
      let glyph = 0;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const idx = idRangeOffsetPos + i * 2 + rangeOffset + (code - start) * 2;
        if (idx >= idRangeOffsetPos && idx + 2 <= tableEnd) {
          const glyphIndex = view.getUint16(idx);
          if (glyphIndex !== 0) glyph = (glyphIndex + delta) & 0xffff;
        }
      }
      out.set(code, glyph);
    }
  }
}

function parseCmapFormat12(view, offset, out){
  const nGroups = view.getUint32(offset + 12);
  let pos = offset + 16;
  for (let i = 0; i < nGroups; i++) {
    const startCode = view.getUint32(pos);
    const endCode = view.getUint32(pos + 4);
    const startGlyph = view.getUint32(pos + 8);
    pos += 12;
    const count = endCode - startCode + 1;
    for (let j = 0; j < count; j++) {
      const code = startCode + j;
      const glyph = startGlyph + j;
      if (code <= 0x10ffff) out.set(code, glyph);
    }
  }
}

function buildFontResource(addPlainObject, addStreamObject, usedGlyphs){
  const glyphSet = new Set(usedGlyphs instanceof Set ? usedGlyphs : []);
  glyphSet.add(FONT_INFO.fallbackGlyph);
  glyphSet.add(0);
  const glyphs = Array.from(glyphSet).filter(g => Number.isInteger(g) && g >= 0 && g < FONT_INFO.glyphCount).sort((a,b) => a-b);
  const widthArray = buildWidthArray(glyphs, FONT_INFO.advanceWidths, FONT_INFO.defaultWidth);
  const toUnicode = buildToUnicodeCMap(glyphs, FONT_INFO.glyphToCode);

  const toUnicodeId = addStreamObject({}, b(toUnicode));
  const fontFileId = addStreamObject({ Length1: FONT_DATA.length }, FONT_DATA);
  const bbox = FONT_INFO.bbox.map(v => Math.round(v));
  const descriptorDict = `<< /Type /FontDescriptor /FontName /${FONT_NAME} /Flags 32 /FontBBox [${bbox.join(' ')}] /ItalicAngle ${formatPDFNumber(FONT_INFO.italicAngle)} /Ascent ${Math.round(FONT_INFO.ascender)} /Descent ${Math.round(FONT_INFO.descender)} /CapHeight ${Math.round(FONT_INFO.capHeight)} /StemV ${Math.round(FONT_INFO.stemV)} /FontFile2 ${fontFileId} 0 R >>`;
  const descriptorId = addPlainObject(descriptorDict);
  const cidParts = [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${FONT_NAME}`,
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`,
    `/FontDescriptor ${descriptorId} 0 R`,
    `/DW ${Math.round(FONT_INFO.defaultWidth)}`];
  if (widthArray) cidParts.push(`/W ${widthArray}`);
  cidParts.push(`/CIDToGIDMap /Identity >>`);
  const cidFontId = addPlainObject(cidParts.join(' '));
  const fontDict = `<< /Type /Font /Subtype /Type0 /BaseFont /${FONT_NAME} /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`;
  const fontId = addPlainObject(fontDict);
  return { fontId, glyphs };
}

function buildWidthArray(glyphs, advanceWidths, defaultWidth){
  if (!glyphs.length) return '';
  const parts = [];
  let runStart = glyphs[0];
  let prev = glyphs[0];
  let run = [Math.round(advanceWidths[runStart] ?? defaultWidth)];
  for (let i = 1; i < glyphs.length; i++) {
    const gid = glyphs[i];
    const width = Math.round(advanceWidths[gid] ?? defaultWidth);
    if (gid === prev + 1) {
      run.push(width);
    } else {
      parts.push(`${runStart} [${run.join(' ')}]`);
      runStart = gid;
      run = [width];
    }
    prev = gid;
  }
  parts.push(`${runStart} [${run.join(' ')}]`);
  return `[${parts.join(' ')}]`;
}

function buildToUnicodeCMap(glyphs, glyphToCode){
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange'
  ];
  const entries = [];
  for (const gid of glyphs) {
    const code = glyphToCode[gid];
    if (code == null) continue;
    const src = gid.toString(16).padStart(4, '0');
    let dest = code.toString(16).toUpperCase();
    if (dest.length % 2 === 1) dest = '0' + dest;
    if (dest.length < 4) dest = dest.padStart(4, '0');
    entries.push(`<${src}> <${dest}>`);
  }
  if (entries.length) {
    const chunkSize = 100;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      lines.push(`${chunk.length} beginbfchar`);
      lines.push(...chunk);
      lines.push('endbfchar');
    }
  } else {
    lines.push('0 beginbfchar', 'endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

function formatPDFNumber(value){
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
  return value.toFixed(4).replace(/\.0+$/, '').replace(/0+$/, '').replace(/\.$/, '');
}

function normalizeBranding(raw, defaults, defaultFooterLine){
  if (!raw || typeof raw !== "object") return null;

  const accent = parseColor(raw.accentColor, [0,0.667,0.467]);
  const accentThickness = isFiniteNumber(raw.accentThickness) ? Math.max(0, raw.accentThickness) : 2;
  let marginLeft = isFiniteNumber(raw.marginLeft) ? raw.marginLeft : 72;
  let marginRight = isFiniteNumber(raw.marginRight) ? raw.marginRight : 43;

  const headerRaw = raw.header || {};
  const headerTitleRaw = headerRaw.title != null ? String(headerRaw.title) : defaults.title;
  const headerSubtitleRaw = headerRaw.subtitle != null ? String(headerRaw.subtitle) : defaults.subtitle;
  const headerTitle = headerTitleRaw ? headerTitleRaw.replace(/×/g, "x") : "";
  const headerSubtitle = headerSubtitleRaw ? headerSubtitleRaw.replace(/×/g, "x") : "";
  const headerTitleSize = isFiniteNumber(headerRaw.titleSize) ? headerRaw.titleSize : 22;
  const headerSubtitleSize = isFiniteNumber(headerRaw.subtitleSize) ? headerRaw.subtitleSize : 12;
  const headerSubtitleGap = isFiniteNumber(headerRaw.subtitleGap)
    ? headerRaw.subtitleGap
    : (headerSubtitle ? headerSubtitleSize + 6 : headerTitleSize / 2);
  const headerHeightCandidate = isFiniteNumber(headerRaw.height) ? headerRaw.height : 0;
  const headerMinHeight =
    (headerTitle ? headerTitleSize + 28 : 0) +
    (headerSubtitle ? headerSubtitleGap + headerSubtitleSize + 12 : 0);
  const headerVisible = Boolean(headerTitle || headerSubtitle || headerRaw.backgroundColor);
  const headerHeight = headerVisible ? Math.max(headerHeightCandidate, headerMinHeight, 60) : 0;
  let headerTitleOffset = isFiniteNumber(headerRaw.titleOffset) ? headerRaw.titleOffset : 36;
  headerTitleOffset = clamp(headerTitleOffset, 16, Math.max(headerHeight - 12, 16));
  const headerBackground = parseColor(headerRaw.backgroundColor, accent);
  const headerTextColor = parseColor(headerRaw.textColor, autoTextColor(headerBackground));
  const headerX = isFiniteNumber(headerRaw.x) ? headerRaw.x : marginLeft;
  const header = {
    title: headerTitle,
    subtitle: headerSubtitle,
    titleSize: headerTitleSize,
    subtitleSize: headerSubtitleSize,
    subtitleGap: headerSubtitleGap,
    height: headerHeight,
    titleOffset: headerTitleOffset,
    background: headerBackground,
    textColor: headerTextColor,
    x: headerX,
    visible: headerVisible
  };

  const footerRaw = raw.footer || {};
  const includeDefaultFooter = footerRaw.includeDefault !== false;
  let footerLines = [];
  if (Array.isArray(footerRaw.lines)) {
    footerLines = footerRaw.lines.map(line => String(line).trim()).filter(Boolean);
  } else if (typeof footerRaw.lines === "string") {
    footerLines = footerRaw.lines.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }
  const templateUrl = typeof raw.templateUrl === "string" ? raw.templateUrl.trim() : "";
  if (includeDefaultFooter) footerLines.push(defaultFooterLine);
  if (templateUrl) footerLines.push(templateUrl);
  footerLines = footerLines.map(line => line.replace(/×/g, "x"));
  const footerFontSize = isFiniteNumber(footerRaw.fontSize) ? footerRaw.fontSize : 10;
  const footerLineHeight = isFiniteNumber(footerRaw.lineHeight) ? footerRaw.lineHeight : footerFontSize + 2;
  const footerHeightCandidate = isFiniteNumber(footerRaw.height) ? footerRaw.height : 0;
  const footerMinHeight = footerLines.length ? footerLines.length * footerLineHeight + 28 : 0;
  const footerVisible = Boolean(footerLines.length || footerHeightCandidate > 0 || footerRaw.backgroundColor);
  const footerHeight = footerVisible ? Math.max(footerHeightCandidate, footerMinHeight, footerLines.length ? 48 : 0) : 0;
  const footerBackground = parseColor(footerRaw.backgroundColor, [0.96,0.96,0.96]);
  const footerTextColor = parseColor(footerRaw.textColor, [0.2,0.2,0.2]);
  const footerX = isFiniteNumber(footerRaw.x) ? footerRaw.x : marginLeft;
  const footer = {
    lines: footerLines,
    fontSize: footerFontSize,
    lineHeight: footerLineHeight,
    height: footerHeight,
    background: footerBackground,
    textColor: footerTextColor,
    x: footerX,
    includeDefault: includeDefaultFooter,
    visible: footerVisible
  };

  const chartTitleColor = parseColor(raw.chartTitleColor, [0,0,0]);

  return {
    marginLeft,
    marginRight,
    accent,
    accentThickness,
    header,
    footer,
    chartTitleColor
  };
}

function drawBranding(branding, dims, encodeText){
  const textFn = typeof encodeText === 'function' ? encodeText : (str => `(${String(str)})`);
  let out = "";
  const width = dims.width, height = dims.height;
  const accentStroke = colorCmd(branding.accent, "RG");
  const accentThickness = branding.accentThickness;

  if (branding.header && branding.header.visible && branding.header.height > 0) {
    const headerBottom = height - branding.header.height;
    out += `${colorCmd(branding.header.background, "rg")} 0 ${headerBottom.toFixed(2)} ${width.toFixed(2)} ${branding.header.height.toFixed(2)} re f\n`;
    if (accentThickness > 0) {
      out += `${accentStroke} ${accentThickness.toFixed(2)} w 0 ${headerBottom.toFixed(2)} m ${width.toFixed(2)} ${headerBottom.toFixed(2)} l S\n`;
    }

    if (branding.header.title) {
      const minBaseline = headerBottom + branding.header.titleSize + 8;
      const maxBaseline = height - 18;
      const desired = height - branding.header.titleOffset;
      const baseline = clamp(desired, minBaseline, maxBaseline);
      out += `BT /F1 ${branding.header.titleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${baseline.toFixed(2)} Td ${textFn(branding.header.title)} Tj ET\n`;
      if (branding.header.subtitle) {
        const subDesired = baseline - branding.header.subtitleGap;
        const subMin = headerBottom + branding.header.subtitleSize + 12;
        const subBaseline = clamp(subDesired, subMin, baseline - 8);
        out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td ${textFn(branding.header.subtitle)} Tj ET\n`;
      }
    } else if (branding.header.subtitle) {
      const subMin = headerBottom + branding.header.subtitleSize + 12;
      const subBaseline = clamp(height - branding.header.titleOffset, subMin, height - 18);
      out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td ${textFn(branding.header.subtitle)} Tj ET\n`;
    }
  }

  if (branding.footer && branding.footer.visible && branding.footer.height > 0) {
    out += `${colorCmd(branding.footer.background, "rg")} 0 0 ${width.toFixed(2)} ${branding.footer.height.toFixed(2)} re f\n`;
    if (accentThickness > 0) {
      out += `${accentStroke} ${accentThickness.toFixed(2)} w 0 ${branding.footer.height.toFixed(2)} m ${width.toFixed(2)} ${branding.footer.height.toFixed(2)} l S\n`;
    }
    let baseline = branding.footer.height - 24;
    for (const line of branding.footer.lines) {
      const safeBaseline = clamp(baseline, 16, branding.footer.height - 12);
      out += `BT /F1 ${branding.footer.fontSize} Tf ${colorCmd(branding.footer.textColor, "rg")} ${branding.footer.x} ${safeBaseline.toFixed(2)} Td ${textFn(line)} Tj ET\n`;
      baseline -= branding.footer.lineHeight;
    }
  }

  return out;
}

/** Składa kompletny PDF (1 strona) z jednym strumieniem treści. */
function buildPDF({ pageWidth, pageHeight, content, usedGlyphs, xObjects }) {
  const chunks = [];
  let pos = 0;
  const offsets = [0];
  const objects = [];

  function push(buf){ chunks.push(buf); pos += buf.length; }
  function addPlainObject(body){ const id = objects.length + 1; objects.push({ id, type: 'plain', body }); return id; }
  function addStreamObject(dict, data){ const id = objects.length + 1; const payload = data instanceof Uint8Array ? data : new Uint8Array(data || []); objects.push({ id, type: 'stream', dict: { ...dict }, data: payload }); return id; }

  // Font resources
  const fontResource = buildFontResource(addPlainObject, addStreamObject, usedGlyphs instanceof Set ? usedGlyphs : new Set());

  // Images
  const imageRefs = [];
  if (Array.isArray(xObjects)) {
    for (const entry of xObjects) {
      if (!entry || !entry.data) continue;
      const dict = {
        Type: '/XObject',
        Subtype: '/Image',
        Width: Math.round(entry.width || 0),
        Height: Math.round(entry.height || 0),
        ColorSpace: entry.colorSpace || '/DeviceRGB',
        BitsPerComponent: entry.bitsPerComponent || 8,
        Filter: entry.filter || '/DCTDecode'
      };
      if (entry.decode) dict.Decode = entry.decode;
      const objId = addStreamObject(dict, entry.data);
      imageRefs.push({ name: entry.name || `Im${imageRefs.length + 1}`, id: objId });
    }
  }

  // Content stream
  const contentBytes = content instanceof Uint8Array ? content : b('');
  const contentId = addStreamObject({}, contentBytes);

  // Page hierarchy
  const pageId = objects.length + 1;
  const pagesId = pageId + 1;
  const catalogId = pagesId + 1;

  const xObjectEntries = imageRefs.length ? imageRefs.map(ref => `/${ref.name} ${ref.id} 0 R`).join(' ') : '';
  const resourceParts = [`/Font << /F1 ${fontResource.fontId} 0 R >>`];
  if (xObjectEntries) resourceParts.push(`/XObject << ${xObjectEntries} >>`);
  const resourcesDict = `<< ${resourceParts.join(' ')} >>`;

  addPlainObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${formatPDFNumber(pageWidth)} ${formatPDFNumber(pageHeight)}] /Resources ${resourcesDict} /Contents ${contentId} 0 R >>`);
  addPlainObject(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  addPlainObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // Header
  push(b(`%PDF-1.4\n%âãÏÓ\n`));

  // Write objects
  for (const obj of objects) {
    offsets[obj.id] = pos;
    push(b(`${obj.id} 0 obj\n`));
    if (obj.type === 'plain') {
      push(b(obj.body));
      if (!obj.body.endsWith('\n')) push(b('\n'));
      push(b(`endobj\n`));
    } else {
      const dict = { ...obj.dict, Length: obj.data.length };
      const dictStr = serializeDict(dict);
      push(b(`${dictStr}\nstream\n`));
      push(obj.data);
      push(b(`\nendstream\nendobj\n`));
    }
  }

  const xrefStart = pos;
  push(b(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (let i = 1; i <= objects.length; i++) {
    const off = offsets[i] ?? 0;
    push(b(`${String(off).padStart(10, '0')} 00000 n \n`));
  }
  push(b(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));

  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total); let off = 0; for (const c of chunks){ out.set(c, off); off += c.length; }
  return out;
}

function serializeDict(dict){
  const parts = ['<<'];
  for (const [key, value] of Object.entries(dict)) {
    if (value == null) continue;
    parts.push(`/${key} ${formatPDFValue(value)}`);
  }
  parts.push('>>');
  return parts.join(' ');
}

function formatPDFValue(value){
  if (typeof value === 'number') return formatPDFNumber(value);
  return String(value);
}

/* ===== Image helpers ===== */
async function fetchImageResource(imageSpec){
  if (!imageSpec || typeof imageSpec !== 'object') return null;
  const urlRaw = imageSpec.url != null ? String(imageSpec.url) : '';
  const url = urlRaw.trim();
  if (!url) return null;
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`Nie udało się pobrać obrazu: ${err && err.message ? err.message : err}`);
  }
  if (!response || !response.ok) {
    throw new Error(`Nie udało się pobrać obrazu: HTTP ${(response && response.status) || '???'}`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!isJPEG(bytes)) {
    throw new Error('Obsługiwane są tylko obrazy JPEG (link powinien wskazywać plik .jpg lub .jpeg).');
  }
  const info = parseJPEG(bytes);
  if (!info || !info.width || !info.height) {
    throw new Error('Nie udało się odczytać parametrów obrazu JPEG.');
  }
  const resource = {
    data: bytes,
    width: info.width,
    height: info.height,
    bitsPerComponent: info.bitsPerComponent || 8,
    colorSpace: info.components === 1 ? '/DeviceGray' : (info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB'),
    filter: '/DCTDecode'
  };
  if (info.components === 4) {
    resource.decode = '[1 0 1 0 1 0 1 0]';
  }
  return resource;
}

function isJPEG(bytes){
  return bytes && bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8;
}

function parseJPEG(bytes){
  if (!isJPEG(bytes)) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xD9) break; // EOI
    if (marker === 0xDA) break; // Start of scan
    if (marker === 0xFF) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      const precision = bytes[offset + 2];
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      return { width, height, components, bitsPerComponent: precision };
    }
    offset += length;
  }
  return null;
}

/** Rysuje wykres i elementy w content stream PDF. */
function makeChartContentStream(payload, opts = {}) {
  const W=595, H=842; // A4
  const defaultFooterLine = "Przeliczenia: 1 m3/h = 0.2778 l/s = 16.667 l/min";
  const imageInput = opts && typeof opts === 'object' ? opts.image : null;

  const points = Array.isArray(payload.curve) ? payload.curve : [];
  const unitsRaw = payload.units || { flow: "m³/h", head: "m" };
  const units = { flow: String(unitsRaw.flow || "m3/h").replace("³","3"), head: String(unitsRaw.head || "m") };
  const chartTitle = String(payload.chartTitle || "Charakterystyka pompy (1x)").replace(/×/g,"x");
  const axis = payload.axis || {};
  const multipliers = (Array.isArray(payload.multipliers) && payload.multipliers.length) ? payload.multipliers : [1,2,3];
  const extraTextLines = Array.isArray(payload.extraText)
    ? payload.extraText.map(line => String(line).replace(/×/g, "x").trim()).filter(Boolean)
    : [];

  const meta = payload.meta || {};
  const pageTitle = String((meta.title != null ? meta.title : "Karta doborowa")).replace(/×/g,"x");
  const modelText = meta.model != null ? `Model: ${String(meta.model).replace(/×/g,"x")}` : "";

  const templateFromStatic = typeof STATIC_BRAND_TEMPLATE_URL === "string"
    ? STATIC_BRAND_TEMPLATE_URL.trim()
    : "";
  let brandingInput = null;
  if (payload && payload.branding && typeof payload.branding === "object") {
    brandingInput = { ...payload.branding };
  } else if (templateFromStatic) {
    brandingInput = {};
  }
  if (brandingInput && templateFromStatic && !brandingInput.templateUrl) {
    brandingInput.templateUrl = templateFromStatic;
  }
  const branding = brandingInput
    ? normalizeBranding(brandingInput, { title: pageTitle, subtitle: modelText }, defaultFooterLine)
    : null;

  let marginLeft = (branding && branding.marginLeft != null) ? branding.marginLeft : 72;
  let marginRight = (branding && branding.marginRight != null) ? branding.marginRight : 43;
  const minMargin = 24;
  const minPlotWidth = 320;
  marginLeft = clamp(marginLeft, minMargin, W - minMargin - minPlotWidth);
  marginRight = clamp(marginRight, minMargin, W - marginLeft - minPlotWidth);
  let plotWidth = W - marginLeft - marginRight;
  if (plotWidth < minPlotWidth) {
    plotWidth = minPlotWidth;
    marginRight = Math.max(minMargin, W - marginLeft - plotWidth);
    if (marginRight < minMargin) {
      marginLeft = Math.max(minMargin, W - plotWidth - minMargin);
      marginRight = W - marginLeft - plotWidth;
    }
  }

  const footerHeight = (branding && branding.footer && branding.footer.height != null) ? branding.footer.height : 0;
  const plotY = Math.max(190, footerHeight + 90);
  const plot = { x: Math.round(marginLeft), y: Math.round(plotY), w: Math.round(plotWidth), h: 360 };

  const flowMaxSource = (axis.flowMax != null) ? axis.flowMax : Math.max(...points.map(p => p.Q));
  const headMaxSource = (axis.headMax != null) ? axis.headMax : Math.max(...points.map(p => p.H));
  const flowMax = flowMaxSource > 0 ? flowMaxSource : 1;
  const headMax = headMaxSource > 0 ? headMaxSource : 1;

  function niceTickStep(max, targetTicks = 6){
    if (!max || max <= 0) return 1;
    const rough = max / targetTicks;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
    const candidates = [1,2,2.5,5,10].map(m => m*pow10);
    return candidates.reduce((best,c)=>Math.abs(c-rough)<Math.abs(best-rough)?c:best, candidates[0]);
  }
  function ticks(max, step){
    const out=[]; for(let v=0; v<=max+1e-9; v+=step){ const val=Number((Math.round(v/step)*step).toFixed(12)); if(val<=max+1e-9) out.push(val); } return out;
  }
  function decimalsFromStep(step){ if(step>=1) return 0; const s=String(step); return s.includes(".")?Math.min(2,s.split(".")[1].length):Math.min(2,Math.ceil(-Math.log10(step))); }

  const flowStep = (axis.flowStep != null) ? axis.flowStep : niceTickStep(flowMax, 6);
  const headStep = (axis.headStep != null) ? axis.headStep : niceTickStep(headMax, 6);
  const flowTicks = ticks(flowMax, flowStep);
  const headTicks = ticks(headMax, headStep);
  const dFlow = decimalsFromStep(flowStep), dHead = decimalsFromStep(headStep);
  const fmtFlow = v => v.toFixed(dFlow), fmtHead = v => v.toFixed(dHead);

  const xOf = q => plot.x + (q/flowMax)*plot.w;
  const yOf = h => plot.y + (h/headMax)*plot.h;

  const usedGlyphs = new Set();
  const encodeText = createPDFTextEncoder(usedGlyphs);

  let s='';

  if (branding) {
    s += drawBranding(branding, { width: W, height: H }, encodeText);
  } else {
    s += `BT /F1 20 Tf 72 792 Td ${encodeText(pageTitle)} Tj ET\n`;
    if (modelText) s += `BT /F1 12 Tf 72 770 Td ${encodeText(modelText)} Tj ET\n`;
  }

  const chartTitleColorCmd = colorCmd(branding ? branding.chartTitleColor : [0,0,0], "rg");
  s += `BT /F1 16 Tf ${chartTitleColorCmd} ${plot.x.toFixed(2)} ${(plot.y + plot.h + 32).toFixed(2)} Td ${encodeText(chartTitle)} Tj ET\n`;

  if (extraTextLines.length) {
    const startY = plot.y + plot.h + 24;
    const minY = plot.y + plot.h - 4;
    const lineGap = 13;
    let currentY = startY;
    for (const line of extraTextLines) {
      if (currentY <= minY) break;
      s += `BT /F1 11 Tf 0 0 0 rg ${plot.x.toFixed(2)} ${currentY.toFixed(2)} Td ${encodeText(line)} Tj ET\n`;
      currentY -= lineGap;
    }
  }

  s += `1.25 w 0 0 0 RG ${plot.x} ${plot.y} ${plot.w} ${plot.h} re S\n`;

  for (const hTick of headTicks) {
    const yy = yOf(hTick).toFixed(2);
    s += `0.5 w 0.85 0.85 0.85 RG ${plot.x} ${yy} m ${plot.x + plot.w} ${yy} l S\n`;
    s += `BT /F1 11 Tf 0 0 0 rg ${plot.x - 26} ${(+yy - 4).toFixed(2)} Td ${encodeText(fmtHead(hTick))} Tj ET\n`;
  }

  for (const qTick of flowTicks) {
    const xx = xOf(qTick).toFixed(2);
    s += `0.5 w 0.9 0.9 0.9 RG ${xx} ${plot.y} m ${xx} ${plot.y + plot.h} l S\n`;
  }

  for (const qTick of flowTicks) {
    const xx = xOf(qTick).toFixed(2);
    s += `1 w 0 0 0 RG ${xx} ${plot.y} m ${xx} ${plot.y - 8} l S\n`;
  }

  const row1Y = plot.y - 20, row2Y = plot.y - 38, row3Y = plot.y - 56;
  for (const qTick of flowTicks) {
    const xx = xOf(qTick).toFixed(2);
    s += `BT /F1 11 Tf ${xx} ${row1Y} Td ${encodeText(fmtFlow(qTick))} Tj ET\n`;
    if (multipliers.includes(2)) s += `BT /F1 11 Tf ${xx} ${row2Y} Td ${encodeText(fmtFlow(qTick*2))} Tj ET\n`;
    if (multipliers.includes(3)) s += `BT /F1 11 Tf ${xx} ${row3Y} Td ${encodeText(fmtFlow(qTick*3))} Tj ET\n`;
  }

  const pageLeft = 0;
  const axisX = plot.x;
  const centerX = (pageLeft + axisX) / 2;
  const OFFSET = -0.25;
  const labelX = Math.round(centerX + (axisX - pageLeft) * OFFSET);

  s += `BT /F1 12 Tf ${labelX} ${row1Y} Td ${encodeText(`Q [${units.flow}] `)} Tj ET\n`;
  if (multipliers.includes(2)) s += `BT /F1 11 Tf ${labelX} ${row2Y} Td ${encodeText("2 pompy")} Tj ET\n`;
  if (multipliers.includes(3)) s += `BT /F1 11 Tf ${labelX} ${row3Y} Td ${encodeText("3 pompy")} Tj ET\n`;

  const tx = plot.x - 56, ty = plot.y + plot.h / 2;
  s += `BT /F1 12 Tf 0 0 0 rg 0 1 -1 0 ${tx} ${ty} Tm ${encodeText(`H [${units.head}]`)} Tj ET\n`;

  if (points.length >= 2) {
    const p0 = points[0];
    s += `2.5 w 0 0 0 RG ${xOf(p0.Q).toFixed(2)} ${yOf(p0.H).toFixed(2)} m\n`;
    for (let i=1;i<points.length;i++){
      const p = points[i];
      s += `${xOf(p.Q).toFixed(2)} ${yOf(p.H).toFixed(2)} l\n`;
    }
    s += `S\n`;
  }

  const xObjects = [];
  if (imageInput && imageInput.data && imageInput.width && imageInput.height) {
    const maxDisplayWidth = Math.min(200, plot.w);
    const maxDisplayHeight = 140;
    const scale = Math.min(1, maxDisplayWidth / imageInput.width, maxDisplayHeight / imageInput.height);
    const displayWidth = imageInput.width * scale;
    const displayHeight = imageInput.height * scale;
    const minBottom = plot.y + plot.h + 4;
    const headerOffset = branding && branding.header && branding.header.visible ? branding.header.height : 0;
    const maxTop = H - headerOffset - 16;
    let bottom = minBottom;
    let top = bottom + displayHeight;
    if (top > maxTop) {
      bottom = Math.max(minBottom, maxTop - displayHeight);
      top = bottom + displayHeight;
    }
    const imgX = plot.x + plot.w - displayWidth;
    s += `q ${displayWidth.toFixed(2)} 0 0 ${displayHeight.toFixed(2)} ${imgX.toFixed(2)} ${bottom.toFixed(2)} cm /Im1 Do Q\n`;
    xObjects.push({
      name: 'Im1',
      width: imageInput.width,
      height: imageInput.height,
      colorSpace: imageInput.colorSpace,
      bitsPerComponent: imageInput.bitsPerComponent,
      filter: imageInput.filter,
      decode: imageInput.decode,
      data: imageInput.data
    });
  }

  if (!branding) {
    s += `BT /F1 10 Tf 0.2 0.2 0.2 rg 72 84 Td ${encodeText(defaultFooterLine)} Tj ET\n`;
  }

  return { pageWidth: W, pageHeight: H, content: b(s), usedGlyphs, xObjects };
}

/* ===== Worker ===== */
export default {
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/test" && req.method === "GET") {
      const html = `<!doctype html><meta charset="utf-8">
      <title>Test rysowania PDF</title>
      <style>
        :root { --fg:#111; --muted:#666; --line:#ddd; --accent:#0a7; }
        *{box-sizing:border-box} body{font:15px system-ui, -apple-system, Segoe UI, Roboto; color:var(--fg); margin:0; padding:24px; max-width:980px}
        h1{margin:0 0 12px 0; font-size:20px}
        p.hint{color:var(--muted); margin:8px 0 16px}
        .grid{display:grid; grid-template-columns: 1fr; gap:16px}
        @media(min-width:900px){ .grid{grid-template-columns: 1.2fr 1fr} }
        fieldset{border:1px solid var(--line); border-radius:10px; padding:16px}
        legend{padding:0 6px; color:var(--muted)}
        label{display:block; font-size:12px; color:var(--muted); margin-bottom:4px}
        input[type=text]{width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:inherit}
        textarea{width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; resize:vertical; min-height:72px}
        .row{display:grid; grid-template-columns: 1fr 1fr; gap:10px}
        table{width:100%; border-collapse:collapse; border:1px solid var(--line); border-radius:10px; overflow:hidden}
        th, td{border-bottom:1px solid var(--line); padding:6px 8px; font-weight:normal; text-align:left}
        thead th{background:#f8f8f8; font-size:13px; color:var(--muted)}
        tbody tr:last-child td{border-bottom:none}
        input.qh{width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font:inherit}
        .actions{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
        button{padding:10px 14px; border:none; border-radius:10px; cursor:pointer; font:inherit; background:var(--accent); color:#fff}
        button.secondary{background:#eee; color:#222}
        .right{display:flex; gap:10px; align-items:center; justify-content:flex-end}
        iframe{width:100%; height:640px; border:1px solid var(--line); border-radius:12px; background:#fff}
        .note{font-size:12px; color:var(--muted)}
        input.qh::-webkit-outer-spin-button,
        input.qh::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input.qh { -moz-appearance: textfield; touch-action: manipulation; }
      </style>

      <h1>Test rysowania PDF</h1>
      <p class="hint">Wpisz dane punktów (Q, H). Wystarczą <b>min. 2 punkty</b>. Akceptuję kropki i przecinki. Maks. 20 linii.</p>

      <div class="grid">
        <div>
          <fieldset>
            <legend>Opis</legend>
            <div class="row">
              <div>
                <label>Tytuł (np. karta)</label>
                <input id="title" type="text" placeholder="np. ACME – Karta doborowa" value="ACME – Karta doborowa">
              </div>
              <div>
                <label>Model</label>
                <input id="model" type="text" placeholder="np. X123" value="X123">
              </div>
            </div>
            <div style="margin-top:10px">
              <label>Tytuł wykresu</label>
              <input id="chartTitle" type="text" placeholder="np. Charakterystyka pompy (1x)" value="Charakterystyka pompy (1x)">
            </div>
          </fieldset>

          <fieldset style="margin-top:16px">
            <legend>Zakres osi (opcjonalnie)</legend>
            <div class="row">
              <div>
                <label>Maks. przepływ – flowMax [m3/h]</label>
                <input id="flowMax" type="text" placeholder="puste = weź z danych" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false">
              </div>
              <div>
                <label>Maks. wysokość – headMax [m]</label>
                <input id="headMax" type="text" placeholder="puste = weź z danych" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false">
              </div>
            </div>
            <p class="note" style="margin-top:8px">Jeśli zostawisz puste, wykres sam dopasuje zakres do wpisanych punktów.</p>
          </fieldset>

          <fieldset style="margin-top:16px">
            <legend>Dodatkowe elementy</legend>
            <div>
              <label>Dodatkowy tekst (każda linia osobno)</label>
              <textarea id="extraText" placeholder="np. Dane kontaktowe&#10;Uwagi dodatkowe"></textarea>
            </div>
            <div style="margin-top:10px">
              <label>Adres URL zdjęcia (JPEG)</label>
              <input id="imageUrl" type="text" placeholder="https://example.com/zdjecie.jpg">
              <p class="note" style="margin-top:6px">Obraz zostanie przeskalowany i umieszczony nad wykresem.</p>
            </div>
          </fieldset>

          <fieldset style="margin-top:16px">
            <legend>Branding (opcjonalnie)</legend>
            <div class="row">
              <div>
                <label>Kolor akcentu (#rrggbb)</label>
                <input id="brandAccent" type="text" placeholder="#009688">
              </div>
              <div>
                <label>Kolor tytułu wykresu (#rrggbb)</label>
                <input id="brandChartColor" type="text" placeholder="#111111">
              </div>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Nagłówek — tytuł</label>
                <input id="brandHeaderTitle" type="text" placeholder="np. ACME Pumps – Raport">
              </div>
              <div>
                <label>Nagłówek — podtytuł</label>
                <input id="brandHeaderSubtitle" type="text" placeholder="np. karta produktu">
              </div>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Kolor tła nagłówka</label>
                <input id="brandHeaderBg" type="text" placeholder="#004d40">
              </div>
              <div>
                <label>Kolor tekstu nagłówka</label>
                <input id="brandHeaderText" type="text" placeholder="#ffffff">
              </div>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Lewy margines treści [pt]</label>
                <input id="brandMarginLeft" type="text" inputmode="decimal" placeholder="np. 72">
              </div>
              <div>
                <label>Prawy margines treści [pt]</label>
                <input id="brandMarginRight" type="text" inputmode="decimal" placeholder="np. 72">
              </div>
            </div>
            <div style="margin-top:10px">
              <label>Linie w stopce (po jednej na linię)</label>
              <textarea id="brandFooterLines" placeholder="np. ACME Sp. z o.o.&#10;www.example.com"></textarea>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Kolor tła stopki</label>
                <input id="brandFooterBg" type="text" placeholder="#f3f3f3">
              </div>
              <div>
                <label>Kolor tekstu stopki</label>
                <input id="brandFooterText" type="text" placeholder="#444444">
              </div>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Grubość linii akcentu [pt]</label>
                <input id="brandAccentThickness" type="text" inputmode="decimal" placeholder="np. 2">
              </div>
              <div>
                <label>Wysokość stopki [pt]</label>
                <input id="brandFooterHeight" type="text" inputmode="decimal" placeholder="auto">
              </div>
            </div>
            <div class="row" style="margin-top:10px">
              <div>
                <label>Wysokość nagłówka [pt]</label>
                <input id="brandHeaderHeight" type="text" inputmode="decimal" placeholder="auto">
              </div>
              <div>
                <label>URL szablonu (opcjonalnie)</label>
                <input id="brandTemplateUrl" type="text" placeholder="https://example.com/szablon.pdf">
              </div>
            </div>
            <p class="note" style="margin-top:8px">Pozostaw puste, jeśli korzystasz z wpisanej na stałe wartości
              <code>STATIC_BRAND_TEMPLATE_URL</code> w pliku <code>worker.js</code>.</p>
            <label style="display:flex; align-items:center; gap:6px; margin-top:10px; font-size:12px; color:var(--muted)">
              <input type="checkbox" id="brandFooterDefault" checked style="width:auto"> Dołącz przeliczenia w stopce
            </label>
          </fieldset>

          <fieldset style="margin-top:16px">
            <legend>Punkty (Q, H)</legend>
            <table>
              <thead><tr><th style="width:50%">Q [m3/h]</th><th>H [m]</th></tr></thead>
              <tbody id="rows">
                ${Array.from({ length: 20 }).map((_, i) => {
                  const idx = i + 1;
                  return `
                <tr>
                  <td><input class="qh" id="q${idx}" type="text" inputmode="decimal" placeholder="np. 1,2" autocomplete="off" autocorrect="off" spellcheck="false"></td>
                  <td><input class="qh" id="h${idx}" type="text" inputmode="decimal" placeholder="np. 28,4" autocomplete="off" autocorrect="off" spellcheck="false"></td>
                </tr>`;
                }).join('')}
              </tbody>
            </table>
            <div class="actions" style="margin-top:10px">
              <button id="fillSample" type="button" class="secondary">Wstaw przykładowe</button>
              <span class="note">Wpisz 2–20 wierszy. Puste komórki są ignorowane.</span>
            </div>
          </fieldset>

          <div class="actions" style="margin-top:16px">
            <button id="renderBtn" type="button">Renderuj PDF</button>
            <button id="clearBtn" type="button" class="secondary">Wyczyść</button>
            <div class="right" style="flex:1">
              <a id="dl" class="secondary" style="text-decoration:none; background:#eee; padding:10px 14px; border-radius:10px; color:#222; display:none">Pobierz PDF</a>
            </div>
          </div>
        </div>

        <div>
          <iframe id="out" title="Podgląd PDF"></iframe>
        </div>
      </div>

      <script>
      (function(){
        // --- Improved sanitization for numeric input ---
        function sanitizeNumericInputValue(raw) {
          if (raw == null) return '';
          let v = String(raw).trimStart();
          v = v.replace(/,/g, '.');
          v = v.replace(/[^0-9.\\-]/g, '');
          const neg = v.startsWith('-');
          v = v.replace(/-/g, '');
          if (neg) v = '-' + v;
          const dot = v.indexOf('.');
          if (dot !== -1) {
            v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\\./g, '');
          }
          return v;
        }

        function setupRowInputs() {
          const tbody = document.getElementById('rows');
          if (!tbody) return;
          tbody.querySelectorAll('input.qh').forEach(function(inp) {
            let composing = false;
            inp.addEventListener('compositionstart', function() { composing = true; });
            inp.addEventListener('compositionend', function(e) {
              composing = false;
              const v = sanitizeNumericInputValue(e.target.value);
              e.target.value = v;
            });
            inp.addEventListener('input', function(e) {
              if (e.isComposing || composing) return;
              const originalValue = e.target.value;
              const sanitizedValue = sanitizeNumericInputValue(originalValue);
              if (originalValue !== sanitizedValue) {
                const selStart = e.target.selectionStart;
                const selEnd = e.target.selectionEnd;
                e.target.value = sanitizedValue;
                const delta = originalValue.length - sanitizedValue.length;
                e.target.setSelectionRange(Math.max(0, selStart - delta), Math.max(0, selEnd - delta));
              }
            });
            inp.addEventListener('wheel', function(ev) { ev.preventDefault(); }, { passive: false });
          });
        }

        function parseNum(v) {
          if (v == null) return null;
          let t = String(v).trim();
          t = t.replace(/[ \\t\\r\\n]+/g, '').replace(/,/g, '.');
          if (t === '' || t === '-' || t === '.' || t === '-.') return null;
          if (t.startsWith('.')) t = '0' + t;
          if (t.startsWith('-.')) t = '-0.' + t.slice(2);
          if (t.endsWith('.')) t = t.slice(0, -1);
          const n = Number(t);
          return Number.isFinite(n) ? n : null;
        }

        function collectPoints() {
          const pts = [];
          for (let i = 1; i <= 20; i++) {
            const qEl = document.getElementById('q' + i);
            const hEl = document.getElementById('h' + i);
            const q = parseNum(qEl && qEl.value);
            const h = parseNum(hEl && hEl.value);
            if (q != null && h != null && q >= 0 && h >= 0) {
              pts.push({ Q: q, H: h });
            }
          }
          if (pts.length < 2) throw new Error('Wpisz przynajmniej 2 linie z Q i H (wartości nieujemne).');
          pts.sort(function(a, b) { return a.Q - b.Q; });
          return pts;
        }

        function collectBranding() {
          function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
          const accent = val('brandAccent').trim();
          const chartColor = val('brandChartColor').trim();
          const headerTitle = val('brandHeaderTitle').trim();
          const headerSubtitle = val('brandHeaderSubtitle').trim();
          const headerBg = val('brandHeaderBg').trim();
          const headerText = val('brandHeaderText').trim();
          const headerHeight = parseNum(val('brandHeaderHeight'));
          const footerLinesRaw = val('brandFooterLines');
          const footerBg = val('brandFooterBg').trim();
          const footerText = val('brandFooterText').trim();
          const footerHeight = parseNum(val('brandFooterHeight'));
          const marginLeft = parseNum(val('brandMarginLeft'));
          const marginRight = parseNum(val('brandMarginRight'));
          const accentThickness = parseNum(val('brandAccentThickness'));
          const templateUrl = val('brandTemplateUrl').trim();
          const includeDefaultEl = document.getElementById('brandFooterDefault');
          const includeDefault = includeDefaultEl ? includeDefaultEl.checked : true;

          const hasHeader = headerTitle || headerSubtitle || headerBg || headerText || headerHeight != null;
          const hasFooterInput = (footerLinesRaw && footerLinesRaw.trim()) || footerBg || footerText || footerHeight != null || includeDefault === false;
          const hasBranding = accent || chartColor || hasHeader || hasFooterInput || marginLeft != null || marginRight != null || accentThickness != null || templateUrl;
          if (!hasBranding) return null;

          const branding = {};
          if (accent) branding.accentColor = accent;
          if (chartColor) branding.chartTitleColor = chartColor;
          if (marginLeft != null) branding.marginLeft = marginLeft;
          if (marginRight != null) branding.marginRight = marginRight;
          if (accentThickness != null) branding.accentThickness = accentThickness;
          if (templateUrl) branding.templateUrl = templateUrl;

          const header = {};
          if (headerTitle) header.title = headerTitle;
          if (headerSubtitle) header.subtitle = headerSubtitle;
          if (headerBg) header.backgroundColor = headerBg;
          if (headerText) header.textColor = headerText;
          if (headerHeight != null) header.height = headerHeight;
          if (Object.keys(header).length) branding.header = header;

          const footer = {};
          const lines = (footerLinesRaw || '').split(/\\r?\\n/).map(function(line) { return line.trim(); }).filter(Boolean);
          if (lines.length) footer.lines = lines;
          if (footerBg) footer.backgroundColor = footerBg;
          if (footerText) footer.textColor = footerText;
          if (footerHeight != null) footer.height = footerHeight;
          if (!includeDefault) footer.includeDefault = false;
          if (Object.keys(footer).length) {
            branding.footer = footer;
          } else if (!includeDefault) {
            branding.footer = { includeDefault: false };
          }
          return branding;
        }

        async function render() {
          try {
            const pts = collectPoints();

            function gv(id, def) { const el = document.getElementById(id); return (el && el.value) ? el.value : def; }
            const title = gv('title', 'Karta doborowa');
            const model = gv('model', '');
            const chartTitle = gv('chartTitle', 'Charakterystyka pompy (1x)');

            const flowMaxIn = parseNum(gv('flowMax', ''));
            const headMaxIn = parseNum(gv('headMax', ''));

            const flowMax = (flowMaxIn != null && flowMaxIn >= 0) ? flowMaxIn : Math.max(...pts.map(p => p.Q));
            const headMax = (headMaxIn != null && headMaxIn >= 0) ? headMaxIn : Math.max(...pts.map(p => p.H));

            const payload = {
              meta: { title: title, model: model },
              units: { flow: "m3/h", head: "m" },
              curve: pts,
              axis: { flowMax: flowMax, headMax: headMax },
              multipliers: [1, 2, 3],
              chartTitle: chartTitle
            };

            const extraTextRaw = gv('extraText', '');
            const extraLines = typeof extraTextRaw === 'string'
              ? extraTextRaw.split(/\r?\n/).map(function(line){ return line.trim(); }).filter(Boolean)
              : [];
            if (extraLines.length) payload.extraText = extraLines;

            const imageUrl = gv('imageUrl', '').trim();
            if (imageUrl) payload.image = { url: imageUrl };

            const branding = collectBranding();
            if (branding) payload.branding = branding;

            const res = await fetch('/render', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (!res.ok) {
              const txt = await res.text();
              throw new Error('Błąd renderowania: ' + res.status + ' ' + txt);
            }
            const imageWarningHeader = res.headers.get('x-image-warning');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const iframe = document.getElementById('out');
            if (iframe) iframe.src = url;

            const dl = document.getElementById('dl');
            if (dl) {
              dl.href = url;
              dl.download = (model ? ('karta-' + model) : 'karta-pompy') + '.pdf';
              dl.style.display = 'inline-block';
            }
            if (imageWarningHeader) {
              let warnText = '';
              try {
                warnText = decodeURIComponent(imageWarningHeader);
              } catch (err) {
                warnText = imageWarningHeader;
              }
              if (warnText && (warnText = warnText.trim())) {
                setTimeout(function(){ alert(warnText + '\nPDF wygenerowano bez zdjęcia.'); }, 0);
              }
            }
          } catch (e) {
            alert(e.message);
          }
        }

        function clearForm() {
          for (let i = 1; i <= 20; i++) {
            const qEl = document.getElementById('q' + i);
            const hEl = document.getElementById('h' + i);
            if (qEl) qEl.value = '';
            if (hEl) hEl.value = '';
          }
          ['brandAccent', 'brandChartColor', 'brandHeaderTitle', 'brandHeaderSubtitle', 'brandHeaderBg',
           'brandHeaderText', 'brandHeaderHeight', 'brandFooterLines', 'brandFooterBg', 'brandFooterText',
           'brandFooterHeight', 'brandMarginLeft', 'brandMarginRight', 'brandAccentThickness', 'brandTemplateUrl',
           'flowMax', 'headMax', 'title', 'model', 'chartTitle', 'extraText', 'imageUrl'
          ].forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.value = '';
          });
          const footerDefault = document.getElementById('brandFooterDefault');
          if (footerDefault) footerDefault.checked = true;
          const dl = document.getElementById('dl');
          if (dl) dl.style.display = 'none';
          const iframe = document.getElementById('out');
          if (iframe) iframe.src = 'about:blank';
        }

        function fillSample() {
          const q = [0.0, 0.4, 0.8, 1.2, 1.6, 1.8];
          const h = [34.0, 33.2, 31.0, 28.4, 26.0, 24.8];
          for (let i = 1; i <= 20; i++) {
            const qEl = document.getElementById('q' + i);
            const hEl = document.getElementById('h' + i);
            const qv = (typeof q[i - 1] !== 'undefined' && q[i - 1] !== null) ? q[i - 1].toString() : '';
            const hv = (typeof h[i - 1] !== 'undefined' && h[i - 1] !== null) ? h[i - 1].toString() : '';
            if (qEl) qEl.value = qv;
            if (hEl) hEl.value = hv;
          }
        }

        function init() {
          setupRowInputs();
          const renderBtn = document.getElementById('renderBtn');
          if (renderBtn) renderBtn.addEventListener('click', render);
          const clearBtn = document.getElementById('clearBtn');
          if (clearBtn) clearBtn.addEventListener('click', clearForm);
          const fillSampleBtn = document.getElementById('fillSample');
          if (fillSampleBtn) fillSampleBtn.addEventListener('click', fillSample);
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', init);
        } else {
          init();
        }
      })();
      </script>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" }});
    }

    if (url.pathname === "/render" && req.method === "POST") {
      let payload;
      try {
        payload = await req.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!payload || !Array.isArray(payload.curve) || payload.curve.length < 2) {
        return new Response('Payload must include curve: [{Q,H}, ...] (min 2)', { status: 400 });
      }
      let imageResource = null;
      let imageWarning = "";
      if (payload.image && typeof payload.image === 'object') {
        try {
          imageResource = await fetchImageResource(payload.image);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          imageWarning = msg ? `Nie udało się pobrać obrazu: ${msg}` : "Nie udało się pobrać obrazu.";
        }
      }
      const { pageWidth, pageHeight, content, usedGlyphs, xObjects } = makeChartContentStream(payload, { image: imageResource });
      const pdf = buildPDF({ pageWidth, pageHeight, content, usedGlyphs, xObjects });
      const headers = {
        "content-type":"application/pdf",
        "content-disposition":"inline; filename=\"karta-pompy.pdf\"",
        "cache-control":"no-store"
      };
      if (imageWarning) {
        const safeWarning = imageWarning.replace(/[\r\n]+/g, " ").trim();
        if (safeWarning) headers["x-image-warning"] = encodeURIComponent(safeWarning).slice(0, 1024);
      }
      return new Response(pdf, { headers });
    }

    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }});
  }
};
