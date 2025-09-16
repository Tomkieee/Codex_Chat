// Worker: generuje PDF z wykresem H(Q) i jedną parą podpisów: "Q [m3/h] ", "2 pompy", "3 pompy" (bez x2/x3).

/* ===== Helpers ===== */
const enc = new TextEncoder();
function b(s){ return enc.encode(s); }
function escapePDFText(str){ return String(str).replace(/([()\\])/g, "\\$1"); }

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

function drawBranding(branding, dims){
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
      out += `BT /F1 ${branding.header.titleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${baseline.toFixed(2)} Td (${escapePDFText(branding.header.title)}) Tj ET\n`;
      if (branding.header.subtitle) {
        const subDesired = baseline - branding.header.subtitleGap;
        const subMin = headerBottom + branding.header.subtitleSize + 12;
        const subBaseline = clamp(subDesired, subMin, baseline - 8);
        out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td (${escapePDFText(branding.header.subtitle)}) Tj ET\n`;
      }
    } else if (branding.header.subtitle) {
      const subMin = headerBottom + branding.header.subtitleSize + 12;
      const subBaseline = clamp(height - branding.header.titleOffset, subMin, height - 18);
      out += `BT /F1 ${branding.header.subtitleSize} Tf ${colorCmd(branding.header.textColor, "rg")} ${branding.header.x} ${subBaseline.toFixed(2)} Td (${escapePDFText(branding.header.subtitle)}) Tj ET\n`;
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
      out += `BT /F1 ${branding.footer.fontSize} Tf ${colorCmd(branding.footer.textColor, "rg")} ${branding.footer.x} ${safeBaseline.toFixed(2)} Td (${escapePDFText(line)}) Tj ET\n`;
      baseline -= branding.footer.lineHeight;
    }
  }

  return out;
}

/** Składa kompletny PDF (1 strona) z jednym strumieniem treści. */
function buildPDF({ pageWidth, pageHeight, contentBytes }) {
  const chunks = []; let pos = 0; const offsets = [0];

  function push(buf){ chunks.push(buf); pos += buf.length; }
  function addObj(id, body){ offsets[id] = pos; push(b(`${id} 0 obj\n`)); push(b(body)); push(b(`\nendobj\n`)); }

  // Header + binary comment line
  push(b(`%PDF-1.4\n%âãÏÓ\n`));

  // Objects
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`);
  addObj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  // Content stream
  const length = contentBytes.length;
  const contentsOffset = pos;
  push(b(`5 0 obj\n<< /Length ${length} >>\nstream\n`));
  push(contentBytes);
  push(b(`\nendstream\nendobj\n`));

  // XRef
  const xrefStart = pos;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    const off = i === 5 ? contentsOffset : offsets[i];
    xref += String(off).padStart(10, '0') + ` 00000 n \n`;
  }
  push(b(xref));
  push(b(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));

  // Concat
  let total=0; for (const c of chunks) total+=c.length;
  const out = new Uint8Array(total); let off=0; for (const c of chunks){ out.set(c,off); off+=c.length; }
  return out;
}

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

  // Zakresy i "ładne" ticki
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

  let s='';

  // Nagłówek / branding
  if (branding) {
    s += drawBranding(branding, { width: W, height: H });
  } else {
    s += `BT /F1 20 Tf 72 792 Td (${escapePDFText(pageTitle)}) Tj ET\n`;
    if (modelText) s += `BT /F1 12 Tf 72 770 Td (${escapePDFText(modelText)}) Tj ET\n`;
  }

  // Tytuł wykresu
  const chartTitleColorCmd = colorCmd(branding ? branding.chartTitleColor : [0,0,0], "rg");
  s += `BT /F1 16 Tf ${chartTitleColorCmd} ${plot.x.toFixed(2)} ${(plot.y + plot.h + 32).toFixed(2)} Td (${escapePDFText(chartTitle)}) Tj ET\n`;

  // Osie (ramka)
  s += `1.25 w 0 0 0 RG ${plot.x} ${plot.y} ${plot.w} ${plot.h} re S\n`;

  // Siatka Y + etykiety
  for (const hTick of headTicks) {
    const yy = yOf(hTick).toFixed(2);
    s += `0.5 w 0.85 0.85 0.85 RG ${plot.x} ${yy} m ${plot.x + plot.w} ${yy} l S\n`;
    s += `BT /F1 11 Tf 0 0 0 rg ${plot.x - 26} ${(+yy - 4).toFixed(2)} Td (${escapePDFText(fmtHead(hTick))}) Tj ET\n`;
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
    s += `BT /F1 11 Tf ${xx} ${row1Y} Td (${escapePDFText(fmtFlow(qTick))}) Tj ET\n`;
    if (multipliers.includes(2)) s += `BT /F1 11 Tf ${xx} ${row2Y} Td (${escapePDFText(fmtFlow(qTick*2))}) Tj ET\n`;
    if (multipliers.includes(3)) s += `BT /F1 11 Tf ${xx} ${row3Y} Td (${escapePDFText(fmtFlow(qTick*3))}) Tj ET\n`;
  }

  // LEWA kolumna opisów (JEDEN zestaw, bez "x2/x3")
  const pageLeft = 0;
  const axisX = plot.x;
  const centerX = (pageLeft + axisX) / 2;
  const OFFSET = -0.25;
  const labelX = Math.round(centerX + (axisX - pageLeft) * OFFSET);

  s += `BT /F1 12 Tf ${labelX} ${row1Y} Td (Q [${escapePDFText(units.flow)}] ) Tj ET\n`;
  if (multipliers.includes(2)) s += `BT /F1 11 Tf ${labelX} ${row2Y} Td (2 pompy) Tj ET\n`;
  if (multipliers.includes(3)) s += `BT /F1 11 Tf ${labelX} ${row3Y} Td (3 pompy) Tj ET\n`;

  // Podpis osi Y (obrócony 90°)
  const tx = plot.x - 56, ty = plot.y + plot.h / 2;
  s += `BT /F1 12 Tf 0 0 0 rg 0 1 -1 0 ${tx} ${ty} Tm (H [${escapePDFText(units.head)}]) Tj ET\n`;

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

  if (!branding) {
    s += `BT /F1 10 Tf 0.2 0.2 0.2 rg 72 84 Td (${escapePDFText(defaultFooterLine)}) Tj ET\n`;
  }

  return { pageWidth: W, pageHeight: H, bytes: b(s) };
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
              <tbody id="rows"></tbody>
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

        function buildRows() {
          const tbody = document.getElementById('rows');
          if (!tbody) return;
          tbody.innerHTML = '';
          for (let i = 1; i <= 20; i++) {
            const tr = document.createElement('tr');
            tr.innerHTML =
              '<td><input class="qh" id="q' + i + '" type="text" inputmode="decimal" ' +
              'placeholder="np. 1,2" autocomplete="off" autocorrect="off" spellcheck="false"></td>' +
              '<td><input class="qh" id="h' + i + '" type="text" inputmode="decimal" ' +
              'placeholder="np. 28,4" autocomplete="off" autocorrect="off" spellcheck="false"></td>';
            tbody.appendChild(tr);
          }

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
           'flowMax', 'headMax', 'title', 'model', 'chartTitle'
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
          buildRows();
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
      const { pageWidth, pageHeight, bytes } = makeChartContentStream(payload);
      const pdf = buildPDF({ pageWidth, pageHeight, contentBytes: bytes });
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
