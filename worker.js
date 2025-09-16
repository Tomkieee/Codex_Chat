// Worker: generuje PDF z wykresem H(Q) i jedną parą podpisów: "Q [m3/h] ", "2 pompy", "3 pompy" (bez x2/x3).

/* ===== Helpers ===== */
const enc = new TextEncoder();
function b(s){ return enc.encode(s); }
function escapePDFText(str){ return String(str).replace(/([()\\])/g, "\\$1"); }

/** Składa kompletny PDF (1 strona) z jednym strumieniem treści. */
function buildPDF({ pageWidth, pageHeight, contentBytes }) {
  const chunks = []; let pos = 0; const offsets = [0];
  function push(buf){ chunks.push(buf); pos += buf.length; }
  function addObj(id, body){ offsets[id] = pos; push(b(`${id} 0 obj\n`)); push(b(body)); push(b(`\nendobj\n`)); }

  push(b(`%PDF-1.4\n`));
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`);
  addObj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const length = contentBytes.length;
  const contentsOffset = pos;
  push(b(`5 0 obj\n<< /Length ${length} >>\nstream\n`));
  push(contentBytes);
  push(b(`\nendstream\nendobj\n`));

  const xrefStart = pos;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i=1;i<=5;i++) xref += String(i===5?contentsOffset:offsets[i]).padStart(10,'0') + ` 00000 n \n`;
  push(b(xref));
  push(b(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));

  let total=0; for (const c of chunks) total+=c.length;
  const out = new Uint8Array(total); let off=0; for (const c of chunks){ out.set(c,off); off+=c.length; }
  return out;
}

/** Rysuje wykres i elementy w content stream PDF. */
function makeChartContentStream(payload) {
  const W=595, H=842; // A4

  // Dane wejściowe
  const points = payload.curve;
  const unitsRaw = payload.units || { flow: "m³/h", head: "m" };
  // ASCII-only (unikamy m³/×):
  const units = { flow: String(unitsRaw.flow || "m3/h").replace("³","3"), head: String(unitsRaw.head || "m") };
  const chartTitle = String(payload.chartTitle || "Charakterystyka pompy (1x)").replace("×","x");
  const axis = payload.axis || {};
  const multipliers = (payload.multipliers && payload.multipliers.length) ? payload.multipliers : [1,2,3];

  // Pole wykresu (więcej miejsca na podpisy)
  const plot = { x: 72, y: 190, w: 480, h: 360 };

  // Zakresy i "ładne" ticki
  const flowMax = axis.flowMax ?? Math.max(...points.map(p => p.Q));
  const headMax = axis.headMax ?? Math.max(...points.map(p => p.H));

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

  const flowStep = axis.flowStep ?? niceTickStep(flowMax, 6);
  const headStep = axis.headStep ?? niceTickStep(headMax, 6);
  const flowTicks = ticks(flowMax, flowStep);
  const headTicks = ticks(headMax, headStep);
  const dFlow = decimalsFromStep(flowStep), dHead = decimalsFromStep(headStep);
  const fmtFlow = v => v.toFixed(dFlow), fmtHead = v => v.toFixed(dHead);

  const xOf = q => plot.x + (q/flowMax)*plot.w;
  const yOf = h => plot.y + (h/headMax)*plot.h;

  let s='';

  // Nagłówek
  const pageTitle = String(payload.meta?.title || "Karta doborowa").replace("×","x");
  s += `BT /F1 20 Tf 72 792 Td (${escapePDFText(pageTitle)}) Tj ET\n`;
  if (payload.meta?.model) s += `BT /F1 12 Tf 72 770 Td (Model: ${escapePDFText(String(payload.meta.model).replace("×","x"))}) Tj ET\n`;

  // Tytuł wykresu
  s += `BT /F1 16 Tf ${plot.x} ${plot.y + plot.h + 32} Td (${escapePDFText(chartTitle)}) Tj ET\n`;

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
  const row1Y = plot.y - 20, row2Y = plot.y - 38, row3Y = plot.y - 56; // trochę więcej odstępu niż wcześniej
  for (const qTick of flowTicks) {
    const xx = xOf(qTick).toFixed(2);
    s += `BT /F1 11 Tf ${xx} ${row1Y} Td (${escapePDFText(fmtFlow(qTick))}) Tj ET\n`;
    if (multipliers.includes(2)) s += `BT /F1 11 Tf ${xx} ${row2Y} Td (${escapePDFText(fmtFlow(qTick*2))}) Tj ET\n`;
    if (multipliers.includes(3)) s += `BT /F1 11 Tf ${xx} ${row3Y} Td (${escapePDFText(fmtFlow(qTick*3))}) Tj ET\n`;
  }

  // LEWA kolumna opisów (UWAGA: tylko JEDEN zestaw, bez "x2/x3")
// ——— lewa kolumna opisów: wspólny X, wyśrodkowany między lewą krawędzią a osią, +10% w prawo ———
const pageLeft = 0;            // zostaw
const axisX    = plot.x;       // zostaw
const centerX  = (pageLeft + axisX) / 2;
const OFFSET   = -0.25;        // spróbuj: -0.15 (bardziej w lewo), ewentualnie -0.20
const labelX   = Math.round(centerX + (axisX - pageLeft) * OFFSET);


// teraz wszystkie trzy podpisy startują od tego samego X
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

  // Stopka (ASCII)
  s += `BT /F1 10 Tf 0.2 0.2 0.2 rg 72 84 Td (Przeliczenia: 1 m3/h = 0.2778 l/s = 16.667 l/min) Tj ET\n`;

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
                <input id="flowMax" type="text" placeholder="puste = weź z danych">
              </div>
              <div>
                <label>Maks. wysokość – headMax [m]</label>
                <input id="headMax" type="text" placeholder="puste = weź z danych">
              </div>
            </div>
            <p class="note" style="margin-top:8px">Jeśli zostawisz puste, wykres sam dopasuje zakres do wpisanych punktów.</p>
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
        // zbuduj 20 wierszy Q/H
        const tbody = document.getElementById('rows');
        for(let i=1;i<=20;i++){
          const tr = document.createElement('tr');
          tr.innerHTML = '<td><input class="qh" id="q'+i+'" inputmode="decimal" placeholder="np. 1.2"></td>'
                       + '<td><input class="qh" id="h'+i+'" inputmode="decimal" placeholder="np. 28.4"></td>';
          tbody.appendChild(tr);
        }
    
        function parseNum(v){
          if (v==null) return null;
          const t = String(v).trim().replace(/\\s+/g,'').replace(',','.');
          if (t==='') return null;
          const n = Number(t);
          return Number.isFinite(n) ? n : null;
        }
    
        function collectPoints(){
          const pts = [];
          for(let i=1;i<=20;i++){
            const q = parseNum(document.getElementById('q'+i).value);
            const h = parseNum(document.getElementById('h'+i).value);
            if (q!=null && h!=null) pts.push({ Q:q, H:h });
          }
          // minimum 2 punkty
          if (pts.length < 2) throw new Error('Wpisz przynajmniej 2 linie z Q i H.');
          // sortuj po Q rosnąco (dla poprawnego rysowania)
          pts.sort((a,b)=>a.Q-b.Q);
          return pts;
        }
    
        async function render(){
          try{
            const pts = collectPoints();
    
            const title = document.getElementById('title').value || 'Karta doborowa';
            const model = document.getElementById('model').value || '';
            const chartTitle = document.getElementById('chartTitle').value || 'Charakterystyka pompy (1x)';
    
            const flowMaxIn = parseNum(document.getElementById('flowMax').value);
            const headMaxIn = parseNum(document.getElementById('headMax').value);
    
            // fallback: jak puste, to bierzemy maks z danych
            const flowMax = flowMaxIn ?? Math.max(...pts.map(p=>p.Q));
            const headMax = headMaxIn ?? Math.max(...pts.map(p=>p.H));
    
            const payload = {
              meta: { title, model },
              units: { flow: "m3/h", head: "m" }, // stałe – jak chciałeś
              curve: pts,
              axis: { flowMax, headMax },
              multipliers: [1,2,3],
              chartTitle
            };
    
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
            document.getElementById('out').src = url;
    
            const dl = document.getElementById('dl');
            dl.href = url;
            dl.download = (model ? ('karta-' + model) : 'karta-pompy') + '.pdf';
            dl.style.display = 'inline-block';
          }catch(e){
            alert(e.message);
          }
        }
    
        document.getElementById('renderBtn').onclick = render;
        document.getElementById('clearBtn').onclick = () => {
          for(let i=1;i<=20;i++){ document.getElementById('q'+i).value=''; document.getElementById('h'+i).value=''; }
          document.getElementById('dl').style.display='none';
          document.getElementById('out').src = 'about:blank';
        };
        document.getElementById('fillSample').onclick = () => {
          const q=[0.0,0.4,0.8,1.2,1.6,1.8], h=[34.0,33.2,31.0,28.4,26.0,24.8];
          for(let i=1;i<=20;i++){
            document.getElementById('q'+i).value = q[i-1] ?? '';
            document.getElementById('h'+i).value = h[i-1] ?? '';            
          }
        };
      </script>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" }});
    }
    if (url.pathname === "/render" && req.method === "POST") {
      let payload; try { payload = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (!payload || !Array.isArray(payload.curve) || payload.curve.length < 2) {
        return new Response('Payload must include curve: [{Q,H}, ...] (min 2)', { status: 400 });
      }
      const { pageWidth, pageHeight, bytes } = makeChartContentStream(payload);
      const pdf = buildPDF({ pageWidth, pageHeight, contentBytes: bytes });
      return new Response(pdf, { headers: { "content-type":"application/pdf","content-disposition":"inline; filename=\"karta-pompy.pdf\"" }});
    }

    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }});
  }
};
