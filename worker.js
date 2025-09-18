 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/worker.js b/worker.js
index 05f91650c8ce7869f2e495fa7c2f7c8552996f1e..4feba968a9a9fae55c4eaa8b19edff88fec78882 100644
--- a/worker.js
+++ b/worker.js
@@ -1,75 +1,408 @@
+import { DEJAVU_SANS_BASE64 } from "./font-data.js";
+
 // Worker: generuje PDF z wykresem H(Q) i jedną parą podpisów: "Q [m3/h] ", "2 pompy", "3 pompy" (bez x2/x3).
 
 /* ===== Helpers ===== */
 const enc = new TextEncoder();
 function b(s){ return enc.encode(s); }
-function escapePDFText(str){ return String(str).replace(/([()\\])/g, "\\$1"); }
 
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
 
+/* ===== Font helpers ===== */
+const FONT_NAME = "DejaVuSans";
+const FONT_DATA = base64ToUint8(DEJAVU_SANS_BASE64);
+const FONT_INFO = parseTrueTypeFont(FONT_DATA, FONT_NAME);
+
+function createPDFTextEncoder(usedGlyphs){
+  const target = usedGlyphs instanceof Set ? usedGlyphs : null;
+  if (target) {
+    target.add(FONT_INFO.fallbackGlyph);
+    target.add(0);
+  }
+  return function encodeForPDF(input){
+    const str = String(input ?? "").replace(/\r?\n/g, " ");
+    if (!str) return "<>";
+    const glyphs = [];
+    for (const ch of str) {
+      const code = ch.codePointAt(0);
+      const glyph = FONT_INFO.codeToGlyph.get(code) ?? FONT_INFO.fallbackGlyph;
+      glyphs.push(glyph);
+      if (target) target.add(glyph);
+    }
+    if (!glyphs.length) return "<>";
+    const hex = glyphs.map(g => g.toString(16).padStart(4, "0")).join("");
+    return `<${hex}>`;
+  };
+}
+
+function base64ToUint8(base64){
+  const clean = String(base64 || "").replace(/\s+/g, "");
+  if (typeof atob === "function") {
+    const binary = atob(clean);
+    const len = binary.length;
+    const out = new Uint8Array(len);
+    for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
+    return out;
+  }
+  const buf = Buffer.from(clean, "base64");
+  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
+}
+
+function parseTrueTypeFont(data, fontName){
+  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
+  const numTables = view.getUint16(4);
+  const tables = {};
+  let ptr = 12;
+  for (let i = 0; i < numTables; i++) {
+    const tag = String.fromCharCode(view.getUint8(ptr), view.getUint8(ptr + 1), view.getUint8(ptr + 2), view.getUint8(ptr + 3));
+    const offset = view.getUint32(ptr + 8);
+    const length = view.getUint32(ptr + 12);
+    tables[tag] = { offset, length };
+    ptr += 16;
+  }
+
+  function requireTable(tag){
+    const entry = tables[tag];
+    if (!entry) throw new Error(`Brak wymaganego bloku TTF: ${tag}`);
+    return entry;
+  }
+
+  const head = requireTable("head");
+  const hhea = requireTable("hhea");
+  const maxp = requireTable("maxp");
+  const hmtx = requireTable("hmtx");
+  const cmap = requireTable("cmap");
+
+  const unitsPerEm = view.getUint16(head.offset + 18);
+  const xMin = view.getInt16(head.offset + 36);
+  const yMin = view.getInt16(head.offset + 38);
+  const xMax = view.getInt16(head.offset + 40);
+  const yMax = view.getInt16(head.offset + 42);
+
+  const ascenderHhea = view.getInt16(hhea.offset + 4);
+  const descenderHhea = view.getInt16(hhea.offset + 6);
+  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
+
+  const numGlyphs = view.getUint16(maxp.offset + 4);
+  const advanceWidths = new Array(numGlyphs);
+  let pos = hmtx.offset;
+  for (let i = 0; i < numberOfHMetrics; i++) {
+    advanceWidths[i] = view.getUint16(pos);
+    pos += 4;
+  }
+  const lastWidth = advanceWidths[numberOfHMetrics - 1] ?? unitsPerEm;
+  for (let i = numberOfHMetrics; i < numGlyphs; i++) advanceWidths[i] = lastWidth;
+
+  let typoAscender = ascenderHhea;
+  let typoDescender = descenderHhea;
+  let capHeight = ascenderHhea * 0.7;
+  let weightClass = 400;
+
+  const os2 = tables["OS/2"];
+  if (os2) {
+    const base = os2.offset;
+    const length = os2.length;
+    const version = view.getUint16(base);
+    if (length >= 6) weightClass = view.getUint16(base + 4);
+    if (length >= 72) {
+      const asc = view.getInt16(base + 68);
+      const desc = view.getInt16(base + 70);
+      if (asc) typoAscender = asc;
+      if (desc) typoDescender = desc;
+    }
+    if (version >= 2 && length >= 90) {
+      const cap = view.getInt16(base + 88);
+      if (cap) capHeight = cap;
+    } else if (length >= 78) {
+      const winAsc = view.getUint16(base + 74);
+      const winDesc = view.getUint16(base + 76);
+      if (winAsc) typoAscender = winAsc;
+      if (winDesc) typoDescender = -winDesc;
+    }
+  }
+
+  const post = tables.post;
+  let italicAngle = 0;
+  if (post) italicAngle = view.getInt32(post.offset + 4) / 65536;
+
+  const cmapData = parseCmap(view, cmap.offset, cmap.length, numGlyphs);
+  const fallbackGlyph = cmapData.codeToGlyph.get(63) ?? cmapData.codeToGlyph.get(32) ?? 0;
+  const spaceGlyph = cmapData.codeToGlyph.get(32);
+  const defaultWidth = spaceGlyph != null ? advanceWidths[spaceGlyph] : unitsPerEm / 2;
+  const stemV = Math.max(50, (weightClass || 400) / 5);
+
+  return {
+    name: fontName,
+    unitsPerEm,
+    ascender: typoAscender,
+    descender: typoDescender,
+    capHeight,
+    bbox: [xMin, yMin, xMax, yMax],
+    italicAngle,
+    advanceWidths,
+    glyphCount: numGlyphs,
+    codeToGlyph: cmapData.codeToGlyph,
+    glyphToCode: cmapData.glyphToCode,
+    fallbackGlyph,
+    defaultWidth,
+    stemV
+  };
+}
+
+function parseCmap(view, offset, length, glyphCount){
+  const numTables = view.getUint16(offset + 2);
+  let best = null;
+  let bestScore = -1;
+  for (let i = 0; i < numTables; i++) {
+    const platformID = view.getUint16(offset + 4 + i * 8);
+    const encodingID = view.getUint16(offset + 6 + i * 8);
+    const subOffset = view.getUint32(offset + 8 + i * 8);
+    const absolute = offset + subOffset;
+    const format = view.getUint16(absolute);
+    if (format !== 4 && format !== 12) continue;
+    const score = cmapPreference(platformID, encodingID, format);
+    if (score > bestScore) {
+      bestScore = score;
+      best = { format, offset: absolute };
+    }
+  }
+  if (!best) throw new Error("Brak obsługiwanego formatu cmap w czcionce");
+
+  const entries = new Map();
+  if (best.format === 4) parseCmapFormat4(view, best.offset, entries);
+  else parseCmapFormat12(view, best.offset, entries);
+
+  const codeToGlyph = new Map();
+  const glyphToCode = new Array(Math.max(0, glyphCount || 0)).fill(null);
+  for (const [code, glyph] of entries) {
+    if (glyph == null) continue;
+    codeToGlyph.set(code, glyph);
+    if (glyph >= 0 && (glyphToCode[glyph] == null || glyphToCode[glyph] > code)) {
+      glyphToCode[glyph] = code;
+    }
+  }
+  return { codeToGlyph, glyphToCode };
+}
+
+function cmapPreference(platform, encoding, format){
+  let base = 0;
+  if (platform === 3 && encoding === 10) base = 4;
+  else if (platform === 0 && encoding === 4) base = 3;
+  else if (platform === 3 && encoding === 1) base = 2;
+  else if (platform === 0 && (encoding === 3 || encoding === 1 || encoding === 0)) base = 2;
+  else if (platform === 3 && encoding === 0) base = 1;
+  if (format === 12) base += 0.5;
+  return base;
+}
+
+function parseCmapFormat4(view, offset, out){
+  const tableLength = view.getUint16(offset + 2);
+  const tableEnd = offset + tableLength;
+  const segCount = view.getUint16(offset + 6) / 2;
+  let pos = offset + 14;
+  const endCount = new Array(segCount);
+  for (let i = 0; i < segCount; i++) { endCount[i] = view.getUint16(pos); pos += 2; }
+  pos += 2; // reservedPad
+  const startCount = new Array(segCount);
+  for (let i = 0; i < segCount; i++) { startCount[i] = view.getUint16(pos); pos += 2; }
+  const idDelta = new Array(segCount);
+  for (let i = 0; i < segCount; i++) { idDelta[i] = view.getInt16(pos); pos += 2; }
+  const idRangeOffsetPos = pos;
+  const idRangeOffset = new Array(segCount);
+  for (let i = 0; i < segCount; i++) { idRangeOffset[i] = view.getUint16(pos); pos += 2; }
+
+  for (let i = 0; i < segCount; i++) {
+    const start = startCount[i];
+    const end = endCount[i];
+    if (start === 0xFFFF && end === 0xFFFF) continue;
+    const delta = idDelta[i];
+    const rangeOffset = idRangeOffset[i];
+    for (let code = start; code <= end; code++) {
+      let glyph = 0;
+      if (rangeOffset === 0) {
+        glyph = (code + delta) & 0xffff;
+      } else {
+        const idx = idRangeOffsetPos + i * 2 + rangeOffset + (code - start) * 2;
+        if (idx >= idRangeOffsetPos && idx + 2 <= tableEnd) {
+          const glyphIndex = view.getUint16(idx);
+          if (glyphIndex !== 0) glyph = (glyphIndex + delta) & 0xffff;
+        }
+      }
+      out.set(code, glyph);
+    }
+  }
+}
+
+function parseCmapFormat12(view, offset, out){
+  const nGroups = view.getUint32(offset + 12);
+  let pos = offset + 16;
+  for (let i = 0; i < nGroups; i++) {
+    const startCode = view.getUint32(pos);
+    const endCode = view.getUint32(pos + 4);
+    const startGlyph = view.getUint32(pos + 8);
+    pos += 12;
+    const count = endCode - startCode + 1;
+    for (let j = 0; j < count; j++) {
+      const code = startCode + j;
+      const glyph = startGlyph + j;
+      if (code <= 0x10ffff) out.set(code, glyph);
+    }
+  }
+}
+
+function buildFontResource(addPlainObject, addStreamObject, usedGlyphs){
+  const glyphSet = new Set(usedGlyphs instanceof Set ? usedGlyphs : []);
+  glyphSet.add(FONT_INFO.fallbackGlyph);
+  glyphSet.add(0);
+  const glyphs = Array.from(glyphSet).filter(g => Number.isInteger(g) && g >= 0 && g < FONT_INFO.glyphCount).sort((a,b) => a-b);
+  const widthArray = buildWidthArray(glyphs, FONT_INFO.advanceWidths, FONT_INFO.defaultWidth);
+  const toUnicode = buildToUnicodeCMap(glyphs, FONT_INFO.glyphToCode);
+
+  const toUnicodeId = addStreamObject({}, b(toUnicode));
+  const fontFileId = addStreamObject({ Length1: FONT_DATA.length }, FONT_DATA);
+  const bbox = FONT_INFO.bbox.map(v => Math.round(v));
+  const descriptorDict = `<< /Type /FontDescriptor /FontName /${FONT_NAME} /Flags 32 /FontBBox [${bbox.join(' ')}] /ItalicAngle${formatPDFNumber(FONT_INFO.italicAngle)} /Ascent ${Math.round(FONT_INFO.ascender)} /Descent ${Math.round(FONT_INFO.descender)} /CapHeight ${Math.round(FONT_INFO.capHeight)} /StemV ${Math.round(FONT_INFO.stemV)} /FontFile2 ${fontFileId} 0 R >>`;
+  const descriptorId = addPlainObject(descriptorDict);
+  const cidParts = [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${FONT_NAME}`,
+    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`,
+    `/FontDescriptor ${descriptorId} 0 R`,
+    `/DW ${Math.round(FONT_INFO.defaultWidth)}`];
+  if (widthArray) cidParts.push(`/W ${widthArray}`);
+  cidParts.push(`/CIDToGIDMap /Identity >>`);
+  const cidFontId = addPlainObject(cidParts.join(' '));
+  const fontDict = `<< /Type /Font /Subtype /Type0 /BaseFont /${FONT_NAME} /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`;
+  const fontId = addPlainObject(fontDict);
+  return { fontId, glyphs };
+}
+
+function buildWidthArray(glyphs, advanceWidths, defaultWidth){
+  if (!glyphs.length) return '';
+  const parts = [];
+  let runStart = glyphs[0];
+  let prev = glyphs[0];
+  let run = [Math.round(advanceWidths[runStart] ?? defaultWidth)];
+  for (let i = 1; i < glyphs.length; i++) {
+    const gid = glyphs[i];
+    const width = Math.round(advanceWidths[gid] ?? defaultWidth);
+    if (gid === prev + 1) {
+      run.push(width);
+    } else {
+      parts.push(`${runStart} [${run.join(' ')}]`);
+      runStart = gid;
+      run = [width];
+    }
+    prev = gid;
+  }
+  parts.push(`${runStart} [${run.join(' ')}]`);
+  return `[${parts.join(' ')}]`;
+}
+
+function buildToUnicodeCMap(glyphs, glyphToCode){
+  const lines = [
+    '/CIDInit /ProcSet findresource begin',
+    '12 dict begin',
+    'begincmap',
+    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
+    '/CMapName /Adobe-Identity-UCS def',
+    '/CMapType 2 def',
+    '1 begincodespacerange',
+    '<0000> <FFFF>',
+    'endcodespacerange'
+  ];
+  const entries = [];
+  for (const gid of glyphs) {
+    const code = glyphToCode[gid];
+    if (code == null) continue;
+    const src = gid.toString(16).padStart(4, '0');
+    let dest = code.toString(16).toUpperCase();
+    if (dest.length % 2 === 1) dest = '0' + dest;
+    if (dest.length < 4) dest = dest.padStart(4, '0');
+    entries.push(`<${src}> <${dest}>`);
+  }
+  if (entries.length) {
+    const chunkSize = 100;
+    for (let i = 0; i < entries.length; i += chunkSize) {
+      const chunk = entries.slice(i, i + chunkSize);
+      lines.push(`${chunk.length} beginbfchar`);
+      lines.push(...chunk);
+      lines.push('endbfchar');
+    }
+  } else {
+    lines.push('0 beginbfchar', 'endbfchar');
+  }
+  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
+  return lines.join('\n');
+}
+
+function formatPDFNumber(value){
+  if (!Number.isFinite(value)) return '0';
+  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
+  return value.toFixed(4).replace(/\.0+$/, '').replace(/0+$/, '').replace(/\.$/, '');
+}
+
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
diff --git a/worker.js b/worker.js
index 05f91650c8ce7869f2e495fa7c2f7c8552996f1e..4feba968a9a9fae55c4eaa8b19edff88fec78882 100644
--- a/worker.js
+++ b/worker.js
@@ -115,137 +448,171 @@ function normalizeBranding(raw, defaults, defaultFooterLine){
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
 
-function drawBranding(branding, dims){
+function drawBranding(branding, dims, encodeText){
+  const textFn = typeof encodeText === 'function' ? encodeText : (str => `(${String(str)})`);
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
-      out += `BT /F1 ${branding.header.titleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${baseline.toFixed(2)} Td (${escapePDFText(branding.header.title)}) Tj ET\n`;
+      out += `BT /F1 ${branding.header.titleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${baseline.toFixed(2)} Td ${textFn(branding.header.title)} Tj ET\n`;
       if (branding.header.subtitle) {
         const subDesired = baseline - branding.header.subtitleGap;
         const subMin = headerBottom + branding.header.subtitleSize + 12;
         const subBaseline = clamp(subDesired, subMin, baseline - 8);
-        out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td (${escapePDFText(branding.header.subtitle)}) Tj ET\n`;
+        out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td ${textFn(branding.header.subtitle)} Tj ET\n`;
       }
     } else if (branding.header.subtitle) {
       const subMin = headerBottom + branding.header.subtitleSize + 12;
       const subBaseline = clamp(height - branding.header.titleOffset, subMin, height - 18);
-      out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td (${escapePDFText(branding.header.subtitle)}) Tj ET\n`;
+      out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td ${textFn(branding.header.subtitle)} Tj ET\n`;
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
-      out += `BT /F1 ${branding.footer.fontSize} Tf ${colorCmd(branding.footer.textColor, "rg")} ${branding.footer.x} ${safeBaseline.toFixed(2)} Td (${escapePDFText(line)}) Tj ET\n`;
+      out += `BT /F1 ${branding.footer.fontSize} Tf ${colorCmd(branding.footer.textColor, "rg")} ${branding.footer.x} ${safeBaseline.toFixed(2)} Td ${textFn(line)} Tj ET\n`;
       baseline -= branding.footer.lineHeight;
     }
   }
 
   return out;
 }
 
 /** Składa kompletny PDF (1 strona) z jednym strumieniem treści. */
-function buildPDF({ pageWidth, pageHeight, contentBytes }) {
-  const chunks = []; let pos = 0; const offsets = [0];
+function buildPDF({ pageWidth, pageHeight, content, usedGlyphs }) {
+  const chunks = [];
+  let pos = 0;
+  const offsets = [0];
+  const objects = [];
 
   function push(buf){ chunks.push(buf); pos += buf.length; }
-  function addObj(id, body){ offsets[id] = pos; push(b(`${id} 0 obj\n`)); push(b(body)); push(b(`\nendobj\n`)); }
+  function addPlainObject(body){ const id = objects.length + 1; objects.push({ id, type: 'plain', body }); return id; }
+  function addStreamObject(dict, data){ const id = objects.length + 1; const payload = data instanceof Uint8Array ? data : new Uint8Array(data || []); objects.push({ id, type: 'stream', dict: { ...dict }, data: payload }); return id; }
 
-  // Header + binary comment line
-  push(b(`%PDF-1.4\n%âãÏÓ\n`));
+  const fontResource = buildFontResource(addPlainObject, addStreamObject, usedGlyphs instanceof Set ? usedGlyphs : new Set());
+
+  const contentBytes = content instanceof Uint8Array ? content : b('');
+  const contentId = addStreamObject({}, contentBytes);
+
+  const pageId = objects.length + 1;
+  const pagesId = pageId + 1;
+  const catalogId = pagesId + 1;
 
-  // Objects
-  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
-  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
-  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`);
-  addObj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
+  const resourcesDict = `<< /Font << /F1 ${fontResource.fontId} 0 R >> >>`;
 
-  // Content stream
-  const length = contentBytes.length;
-  const contentsOffset = pos;
-  push(b(`5 0 obj\n<< /Length ${length} >>\nstream\n`));
-  push(contentBytes);
-  push(b(`\nendstream\nendobj\n`));
+  addPlainObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${formatPDFNumber(pageWidth)} ${formatPDFNumber(pageHeight)}] /Resources ${resourcesDict} /Contents ${contentId} 0 R >>`);
+  addPlainObject(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
+  addPlainObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
+
+  push(b(`%PDF-1.4\n%âãÏÓ\n`));
+
+  for (const obj of objects) {
+    offsets[obj.id] = pos;
+    push(b(`${obj.id} 0 obj\n`));
+    if (obj.type === 'plain') {
+      push(b(obj.body));
+      if (!obj.body.endsWith('\n')) push(b('\n'));
+      push(b(`endobj\n`));
+    } else {
+      const dict = { ...obj.dict, Length: obj.data.length };
+      const dictStr = serializeDict(dict);
+      push(b(`${dictStr}\nstream\n`));
+      push(obj.data);
+      push(b(`\nendstream\nendobj\n`));
+    }
+  }
 
-  // XRef
   const xrefStart = pos;
-  let xref = `xref\n0 6\n0000000000 65535 f \n`;
-  for (let i = 1; i <= 5; i++) {
-    const off = i === 5 ? contentsOffset : offsets[i];
-    xref += String(off).padStart(10, '0') + ` 00000 n \n`;
+  push(b(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
+  for (let i = 1; i <= objects.length; i++) {
+    const off = offsets[i] ?? 0;
+    push(b(`${String(off).padStart(10, '0')} 00000 n \n`));
   }
-  push(b(xref));
-  push(b(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));
+  push(b(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));
 
-  // Concat
   let total=0; for (const c of chunks) total+=c.length;
   const out = new Uint8Array(total); let off=0; for (const c of chunks){ out.set(c,off); off+=c.length; }
   return out;
 }
 
+function serializeDict(dict){
+  const parts = ['<<'];
+  for (const [key, value] of Object.entries(dict)) {
+    if (value == null) continue;
+    parts.push(`/${key} ${formatPDFValue(value)}`);
+  }
+  parts.push('>>');
+  return parts.join(' ');
+}
+
+function formatPDFValue(value){
+  if (typeof value === 'number') return formatPDFNumber(value);
+  return String(value);
+}
+
 /** Rysuje wykres i elementy w content stream PDF. */
 function makeChartContentStream(payload) {
   const W=595, H=842; // A4
   const defaultFooterLine = "Przeliczenia: 1 m3/h = 0.2778 l/s = 16.667 l/min";
 
   // Dane wejściowe
   const points = Array.isArray(payload.curve) ? payload.curve : [];
   const unitsRaw = payload.units || { flow: "m³/h", head: "m" };
   // ASCII-only (unikamy m³/×):
   const units = { flow: String(unitsRaw.flow || "m3/h").replace("³","3"), head: String(unitsRaw.head || "m") };
   const chartTitle = String(payload.chartTitle || "Charakterystyka pompy (1x)").replace(/×/g,"x");
   const axis = payload.axis || {};
   const multipliers = (Array.isArray(payload.multipliers) && payload.multipliers.length) ? payload.multipliers : [1,2,3];
 
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
diff --git a/worker.js b/worker.js
index 05f91650c8ce7869f2e495fa7c2f7c8552996f1e..4feba968a9a9fae55c4eaa8b19edff88fec78882 100644
--- a/worker.js
+++ b/worker.js
@@ -284,126 +651,129 @@ function makeChartContentStream(payload) {
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
 
+  const usedGlyphs = new Set();
+  const encodeText = createPDFTextEncoder(usedGlyphs);
+
   let s='';
 
   // Nagłówek / branding
   if (branding) {
-    s += drawBranding(branding, { width: W, height: H });
+    s += drawBranding(branding, { width: W, height: H }, encodeText);
   } else {
-    s += `BT /F1 20 Tf 72 792 Td (${escapePDFText(pageTitle)}) Tj ET\n`;
-    if (modelText) s += `BT /F1 12 Tf 72 770 Td (${escapePDFText(modelText)}) Tj ET\n`;
+    s += `BT /F1 20 Tf 72 792 Td ${encodeText(pageTitle)} Tj ET\n`;
+    if (modelText) s += `BT /F1 12 Tf 72 770 Td ${encodeText(modelText)} Tj ET\n`;
   }
 
   // Tytuł wykresu
   const chartTitleColorCmd = colorCmd(branding ? branding.chartTitleColor : [0,0,0], "rg");
-  s += `BT /F1 16 Tf ${chartTitleColorCmd} ${plot.x.toFixed(2)} ${(plot.y + plot.h + 32).toFixed(2)} Td (${escapePDFText(chartTitle)}) Tj ET\n`;
+  s += `BT /F1 16 Tf ${chartTitleColorCmd} ${plot.x.toFixed(2)} ${(plot.y + plot.h + 32).toFixed(2)} Td ${encodeText(chartTitle)} Tj ET\n`;
 
   // Osie (ramka)
   s += `1.25 w 0 0 0 RG ${plot.x} ${plot.y} ${plot.w} ${plot.h} re S\n`;
 
   // Siatka Y + etykiety
   for (const hTick of headTicks) {
     const yy = yOf(hTick).toFixed(2);
     s += `0.5 w 0.85 0.85 0.85 RG ${plot.x} ${yy} m ${plot.x + plot.w} ${yy} l S\n`;
-    s += `BT /F1 11 Tf 0 0 0 rg ${plot.x - 26} ${(+yy - 4).toFixed(2)} Td (${escapePDFText(fmtHead(hTick))}) Tj ET\n`;
+    s += `BT /F1 11 Tf 0 0 0 rg ${plot.x - 26} ${(+yy - 4).toFixed(2)} Td ${encodeText(fmtHead(hTick))} Tj ET\n`;
   }
 
   // Siatka X (pion)
   for (const qTick of flowTicks) {
     const xx = xOf(qTick).toFixed(2);
     s += `0.5 w 0.9 0.9 0.9 RG ${xx} ${plot.y} m ${xx} ${plot.y + plot.h} l S\n`;
   }
 
   // Ticki X
   for (const qTick of flowTicks) {
     const xx = xOf(qTick).toFixed(2);
     s += `1 w 0 0 0 RG ${xx} ${plot.y} m ${xx} ${plot.y - 8} l S\n`;
   }
 
   // Etykiety X (1. rząd) + mnożone wartości (2. i 3. rząd)
   const row1Y = plot.y - 20, row2Y = plot.y - 38, row3Y = plot.y - 56;
   for (const qTick of flowTicks) {
     const xx = xOf(qTick).toFixed(2);
-    s += `BT /F1 11 Tf ${xx} ${row1Y} Td (${escapePDFText(fmtFlow(qTick))}) Tj ET\n`;
-    if (multipliers.includes(2)) s += `BT /F1 11 Tf ${xx} ${row2Y} Td (${escapePDFText(fmtFlow(qTick*2))}) Tj ET\n`;
-    if (multipliers.includes(3)) s += `BT /F1 11 Tf ${xx} ${row3Y} Td (${escapePDFText(fmtFlow(qTick*3))}) Tj ET\n`;
+    s += `BT /F1 11 Tf ${xx} ${row1Y} Td ${encodeText(fmtFlow(qTick))} Tj ET\n`;
+    if (multipliers.includes(2)) s += `BT /F1 11 Tf ${xx} ${row2Y} Td ${encodeText(fmtFlow(qTick*2))} Tj ET\n`;
+    if (multipliers.includes(3)) s += `BT /F1 11 Tf ${xx} ${row3Y} Td ${encodeText(fmtFlow(qTick*3))} Tj ET\n`;
   }
 
   // LEWA kolumna opisów (JEDEN zestaw, bez "x2/x3")
   const pageLeft = 0;
   const axisX = plot.x;
   const centerX = (pageLeft + axisX) / 2;
   const OFFSET = -0.25;
   const labelX = Math.round(centerX + (axisX - pageLeft) * OFFSET);
 
-  s += `BT /F1 12 Tf ${labelX} ${row1Y} Td (Q [${escapePDFText(units.flow)}] ) Tj ET\n`;
-  if (multipliers.includes(2)) s += `BT /F1 11 Tf ${labelX} ${row2Y} Td (2 pompy) Tj ET\n`;
-  if (multipliers.includes(3)) s += `BT /F1 11 Tf ${labelX} ${row3Y} Td (3 pompy) Tj ET\n`;
+  s += `BT /F1 12 Tf ${labelX} ${row1Y} Td ${encodeText(`Q [${units.flow}] `)} Tj ET\n`;
+  if (multipliers.includes(2)) s += `BT /F1 11 Tf ${labelX} ${row2Y} Td ${encodeText("2 pompy")} Tj ET\n`;
+  if (multipliers.includes(3)) s += `BT /F1 11 Tf ${labelX} ${row3Y} Td ${encodeText("3 pompy")} Tj ET\n`;
 
   // Podpis osi Y (obrócony 90°)
   const tx = plot.x - 56, ty = plot.y + plot.h / 2;
-  s += `BT /F1 12 Tf 0 0 0 rg 0 1 -1 0 ${tx} ${ty} Tm (H [${escapePDFText(units.head)}]) Tj ET\n`;
+  s += `BT /F1 12 Tf 0 0 0 rg 0 1 -1 0 ${tx} ${ty} Tm ${encodeText(`H [${units.head}]`)} Tj ET\n`;
 
   // Krzywa (grubsza)
   if (points.length >= 2) {
     const p0 = points[0];
     s += `2.5 w 0 0 0 RG ${xOf(p0.Q).toFixed(2)} ${yOf(p0.H).toFixed(2)} m\n`;
     for (let i=1;i<points.length;i++){
       const p = points[i];
       s += `${xOf(p.Q).toFixed(2)} ${yOf(p.H).toFixed(2)} l\n`;
     }
     s += `S\n`;
   }
 
-  if (!branding) {
-    s += `BT /F1 10 Tf 0.2 0.2 0.2 rg 72 84 Td (${escapePDFText(defaultFooterLine)}) Tj ET\n`;
-  }
+    if (!branding) {
+      s += `BT /F1 10 Tf 0.2 0.2 0.2 rg 72 84 Td ${encodeText(defaultFooterLine)} Tj ET\n`;
+    }
 
-  return { pageWidth: W, pageHeight: H, bytes: b(s) };
+    return { pageWidth: W, pageHeight: H, content: b(s), usedGlyphs };
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
diff --git a/worker.js b/worker.js
index 05f91650c8ce7869f2e495fa7c2f7c8552996f1e..4feba968a9a9fae55c4eaa8b19edff88fec78882 100644
--- a/worker.js
+++ b/worker.js
@@ -804,39 +1174,39 @@ export default {
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
-      const { pageWidth, pageHeight, bytes } = makeChartContentStream(payload);
-      const pdf = buildPDF({ pageWidth, pageHeight, contentBytes: bytes });
+      const { pageWidth, pageHeight, content, usedGlyphs } = makeChartContentStream(payload);
+      const pdf = buildPDF({ pageWidth, pageHeight, content, usedGlyphs });
       return new Response(pdf, {
         headers: {
           "content-type":"application/pdf",
           "content-disposition":"inline; filename=\"karta-pompy.pdf\"",
           "cache-control":"no-store"
         }
       });
     }
 
     return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }});
   }
 };
 
EOF
)
