// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
//
// Cross-references two shared Google Sheets and writes ./public/data.json for the
// static dashboard. READ-ONLY: it only fetches the sheets via CSV export endpoints;
// it never writes to them.
//
// DATA MODEL (this account) --------------------------------------------------
//   1) Métricas dos Anúncios — aba "Meta Ads" (gid 0): Day / Campaign Name /
//      Ad Set Name / Ad Name / Amount Spent / Impressions / Link Clicks /
//      Landing Page Views / Checkouts Initiated. Uma linha por dia×campanha×conjunto×anúncio.
//   2) Vendas Geral (Hotmart) — aba "Vendas Geral (Hotmart)" (gid 86137300): planilha
//      GERAL da conta (vários produtos). Colunas relevantes:
//        Data (DD/MM/YYYY) · Hora · Status · Produto · Tipo · Comprador(a) · E-mail ·
//        Valor bruto (BRL) · Origem UTM (bruto) · Detalhe UTM.
//      Filtramos por PRODUTO (coluna "Produto"): só o CORE e o ORDER BUMP desta oferta.
//        CORE = "Efeito Próximo Nível"      (cada linha = 1 venda)
//        BUMP = "Case de Promoção"          (order bump — soma como RECEITA ao pedido
//                                            do mesmo comprador; NÃO conta venda nova)
//      A planilha NÃO tem coluna "Pedido"; o bump é ligado ao core pelo E-MAIL do
//      comprador (linha de core mais próxima no tempo).
//      ATRIBUIÇÃO: não há utm_campaign/medium/content separados — vem da coluna
//      "Detalhe UTM" (formato SCK "<conjunto> | <campanha> | <placement> | <ANÚNCIO>";
//      o ANÚNCIO é o último segmento). Conjunto e campanha têm " | " interno, então
//      casamos pelo MAIOR nome conhecido presente na string. Origem paga = coluna
//      "Origem UTM (bruto)" == "Facebook-Ads".
//      RECEITA (faturamento): coluna "Fat. líquido (USD)" — valor LÍQUIDO em DÓLAR.
//      Vai CRU em US$ no data.json; o dashboard converte p/ BRL ×câmbio (como o gasto).
//      (A coluna "Fat. líquido (BRL)" vem quebrada com #REF!, por isso usamos a USD.)
//
// MOEDA: a conta de anúncios é em DÓLAR (USD). Gasto E faturamento vão CRUS em USD no
// data.json; o dashboard multiplica por meta.fx (câmbio USD→BRL, buscado ao vivo a cada
// build) para exibir TODAS as métricas de dinheiro em REAL (BRL). SEM imposto (meta.tax = 1).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

// --- Sources ----------------------------------------------------------------
const ADS_ID    = '1BAJ8Ovw470t78iz-mYfvLfqzcMyZ-dtDRFrgdYZIXNQ';
const BUYERS_ID = '1v3mc-Z3lUYzGGkyIIYdK9PL3M-O6cgIBTlUWHQDboGU';
const SALES_GID = '86137300';                      // aba "Vendas Geral (Hotmart)"
const SALES_TAB = 'Vendas Geral (Hotmart)';        // rótulo p/ o dashboard

const SHEET_ADS   = `https://docs.google.com/spreadsheets/d/${ADS_ID}/export?format=csv&gid=0`;
const SHEET_SALES = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/export?format=csv&gid=${SALES_GID}`;

const ADS_URL    = `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit`;
const BUYERS_URL = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/edit`;

// --- Produtos desta oferta (filtro na coluna "Produto") ---------------------
const CORE_PRODUCT = 'efeito próximo nível';   // produto principal (comparado com fold)
const BUMP_PRODUCT = 'case de promoção';       // order bump

// --- Tax on ad spend --------------------------------------------------------
// A conta é em USD → sem imposto brasileiro sobre o gasto. Deixe 1 para desligar.
const TAX_RATE = 1;

// --- Status que contam como venda válida (Hotmart) --------------------------
const PAID_STATUS = new Set(['aprovado', 'approved', 'completo', 'complete', 'completed',
                             'pago', 'paid', 'concluido', 'concluída', 'concluida']);

// --- Câmbio USD→BRL: cotação DO MOMENTO (tempo real) ------------------------
// Fonte primária: AwesomeAPI (dólar comercial, mercado BR, atualiza a cada ~minuto) —
// usamos o "bid" (cotação de compra), que é a cotação do instante do build.
// Se falhar, cai para open.er-api.com (cotação DIÁRIA) e, por último, valor fixo.
const FX_REALTIME = 'https://economia.awesomeapi.com.br/last/USD-BRL';
const FX_DAILY    = 'https://open.er-api.com/v6/latest/USD';
const FX_FALLBACK = 5.14;  // usado só se ambas as fontes falharem
async function fetchFxUsdBrl() {
  // 1) tempo real (AwesomeAPI) — a cotação do momento
  try {
    const r = await fetch(FX_REALTIME, { headers: { 'User-Agent': 'funnel-dashboard-build' } });
    if (r.ok) {
      const j = await r.json();
      const q = j && j.USDBRL;
      const rate = q && Number(q.bid);
      if (Number.isFinite(rate) && rate > 0) {
        return { fx: rate, date: q.create_date || null, source: 'awesomeapi.com.br (tempo real, bid)' };
      }
    }
  } catch (e) { console.warn('FX tempo real falhou:', e.message); }
  // 2) diária (open.er-api.com) — backup
  try {
    const r = await fetch(FX_DAILY, { headers: { 'User-Agent': 'funnel-dashboard-build' } });
    if (r.ok) {
      const j = await r.json();
      const rate = j && j.rates && Number(j.rates.BRL);
      if (Number.isFinite(rate) && rate > 0) {
        return { fx: rate, date: j.time_last_update_utc || null, source: 'open.er-api.com (diária)' };
      }
    }
  } catch (e) { console.warn('FX diária falhou:', e.message); }
  // 3) fallback fixo
  return { fx: FX_FALLBACK, date: null, source: 'fallback' };
}

// ---------------------------------------------------------------------------
// CSV parser (quoted fields, escaped quotes, embedded newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Number in Brazilian or plain format: "1.234,56" / "46,9" / "197" / "R$ 355,68"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim().replace(/^R\$\s*/i, '').replace(/^\$\s*/, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Collapse whitespace + trim (join keys sometimes differ only by double spaces).
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Lowercase + strip accents (for matching).
const fold = (s) => normKey(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const pad = (n) => String(n).padStart(2, '0');

// Extract YYYY-MM-DD from "31/08/2026", "6/8/2026", ISO…
function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // D/M/YYYY (Brazil)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return null;
}
// Timestamp (ms) para ordenar/parear bump↔core: data + hora.
function tsOf(iso, hora) {
  const h = String(hora || '').trim();
  const t = Date.parse(`${iso}T${/^\d{1,2}:\d{2}/.test(h) ? h : '00:00:00'}Z`);
  return Number.isFinite(t) ? t : Date.parse(`${iso}T00:00:00Z`);
}

async function fetchText(url, label) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${label}`);
  const body = await r.text();
  if (/^\s*<!DOCTYPE html/i.test(body)) {
    throw new Error(`Got an HTML page instead of CSV for ${label} — the sheet is probably NOT shared publicly (set "Anyone with the link → Viewer").`);
  }
  return body;
}
// Case/space-insensitive header lookup; accepts several aliases.
function headerIndex(h, ...names) {
  const want = names.map((n) => fold(n));
  return h.findIndex((x) => want.includes(fold(x)));
}

(async () => {
  const [csvAds, csvSales, fxInfo] = await Promise.all([
    fetchText(SHEET_ADS, 'ads sheet'),
    fetchText(SHEET_SALES, `buyers tab "${SALES_TAB}"`),
    fetchFxUsdBrl(),
  ]);

  // ---------------- Sheet 1: Meta Ads metrics ----------------
  const a = parseCSV(csvAds);
  const h1 = a[0] || [];
  const I = {
    day:   headerIndex(h1, 'Day'),
    camp:  headerIndex(h1, 'Campaign Name'),
    set:   headerIndex(h1, 'Ad Set Name'),
    ad:    headerIndex(h1, 'Ad Name'),
    spend: headerIndex(h1, 'Amount Spent'),
    imp:   headerIndex(h1, 'Impressions'),
    clk:   headerIndex(h1, 'Link Clicks'),
    lpv:   headerIndex(h1, 'Landing Page Views'),
    chk:   headerIndex(h1, 'Checkouts Initiated'),
  };
  const ads = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    ads.push({
      d: day,
      c: normKey(r[I.camp]),
      s: normKey(r[I.set]),
      a: normKey(r[I.ad]),
      spend: num(r[I.spend]),                       // GROSS em USD — câmbio aplicado no dashboard
      imp: Math.round(num(r[I.imp])),
      clk: Math.round(num(r[I.clk])),
      lpv: I.lpv >= 0 ? Math.round(num(r[I.lpv])) : 0,
      ic:  I.chk >= 0 ? Math.round(num(r[I.chk])) : 0,
    });
  }

  // Canonical name lookups (folded → original ads-sheet spelling) so a sale's
  // campaign/conjunto/anúncio join EXACTLY to the ad rows in the grouping tables.
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  const spendByCombo = new Map();
  for (const r of ads) {
    if (r.c) canonCamp.set(fold(r.c), r.c);
    if (r.s) canonSet.set(fold(r.s), r.s);
    if (r.a) canonAd.set(fold(r.a), r.a);
    if (r.a) {
      const ak = fold(r.a);
      const m = spendByCombo.get(ak) || new Map();
      const k = r.c + '||' + r.s;
      m.set(k, (m.get(k) || 0) + r.spend);
      spendByCombo.set(ak, m);
    }
  }
  const adToCombo = new Map();
  for (const [ak, m] of spendByCombo) {
    let best = '||', bestSpend = -Infinity;
    for (const [k, sp] of m) if (sp > bestSpend) { bestSpend = sp; best = k; }
    const [c, s] = best.split('||');
    adToCombo.set(ak, { c, s });
  }

  // (anúncio + conjunto) → campanha de maior gasto.
  const campByAdSet = new Map();
  for (const r of ads) {
    if (!r.a) continue;
    const k = fold(r.a) + '|' + fold(r.s);
    const mm = campByAdSet.get(k) || new Map();
    mm.set(r.c, (mm.get(r.c) || 0) + r.spend);
    campByAdSet.set(k, mm);
  }
  const campForAdSet = (adFold, setFold) => {
    const mm = campByAdSet.get(adFold + '|' + setFold);
    if (!mm) return '';
    let best = '', bs = -Infinity;
    for (const [c, sp] of mm) if (sp > bs) { bs = sp; best = c; }
    return best;
  };

  // "Detalhe UTM" (SCK do Meta): "<conjunto> | <campanha> | <placement> | <ANÚNCIO>".
  // O ANÚNCIO (criativo) é o ÚLTIMO segmento. Conjunto e campanha têm " | " interno,
  // então casamos pelo MAIOR nome conhecido presente como substring (fold + includes).
  const sckSegments = (s) => String(s == null ? '' : s).split('|').map((p) => normKey(p));
  const longestInSck = (rawSck, canonMap) => {
    const hay = fold(rawSck);
    let best = '', bestLen = 0;
    for (const [cf, orig] of canonMap) if (cf && cf.length > bestLen && hay.includes(cf)) { bestLen = cf.length; best = orig; }
    return best;
  };
  const adFromSck = (rawSck, segs) => {         // criativo = último segmento; senão, maior anúncio casado na SCK
    for (let i = segs.length - 1; i >= 0; i--) { const c = canonAd.get(fold(segs[i])); if (c) return c; }
    return longestInSck(rawSck, canonAd);
  };
  // utm_source values that mean "paid Meta traffic".
  const isPaidSource = (s) => /^(fb|facebook|facebook[-\s]?ads|meta|meta[-\s]?ads|ig|instagram)$/i.test(String(s || '').trim());

  // ---------------- Sheet 2: Vendas Geral (Hotmart) ----------------
  const b = parseCSV(csvSales);
  const h2 = b[0] || [];
  const B = {
    date:  headerIndex(h2, 'Data', 'Data da Compra', 'Data do pedido'),
    hora:  headerIndex(h2, 'Hora', 'Horário'),
    stat:  headerIndex(h2, 'Status', 'Situação', 'Situacao'),
    prod:  headerIndex(h2, 'Produto'),
    tipo:  headerIndex(h2, 'Tipo'),
    mail:  headerIndex(h2, 'E-mail', 'Email'),
    // Faturamento em US$ (col M). NÃO incluir a coluna BRL aqui: headerIndex devolve a
    // PRIMEIRA coluna que casa qualquer alias, e "Valor bruto (BRL)" vem ANTES da USD.
    val:   headerIndex(h2, 'Fat. líquido (USD)', 'Fat. liquido (USD)', 'Faturamento líquido (USD)'),
    src:   headerIndex(h2, 'Origem UTM (bruto)', 'Origem UTM', 'Origem'),
    det:   headerIndex(h2, 'Detalhe UTM', 'Detalhe', 'SCK'),
  };
  if (B.prod < 0) throw new Error('Coluna "Produto" não encontrada na aba de vendas.');
  if (B.val < 0)  throw new Error('Coluna de valor não encontrada na aba de vendas.');

  const statusOk = (s) => { const f = fold(s); return f === '' ? true : PAID_STATUS.has(f); };

  // 1ª passada: separa linhas do CORE e do BUMP (só do produto desta oferta).
  const cores = [];   // {d, ts, email, value, rawSrc, rawDet}
  const bumps = [];   // {d, ts, email, value}
  let skippedStatus = 0;
  for (let i = 1; i < b.length; i++) {
    const r = b[i];
    if (!r || r.length < 2) continue;
    const d = isoDate(r[B.date]);
    if (!d) continue;
    const prodF = fold(r[B.prod]);
    const isCore = prodF === fold(CORE_PRODUCT);
    const isBump = prodF === fold(BUMP_PRODUCT);
    if (!isCore && !isBump) continue;                 // produto de outra oferta → ignora
    if (B.stat >= 0 && !statusOk(r[B.stat])) { skippedStatus++; continue; }
    const value = num(r[B.val]);
    const email = fold(B.mail >= 0 ? r[B.mail] : '');
    const ts    = tsOf(d, B.hora >= 0 ? r[B.hora] : '');
    if (isCore) cores.push({ d, ts, email, value, rawSrc: String(r[B.src] || ''), rawDet: String(B.det >= 0 ? r[B.det] : '') });
    else        bumps.push({ d, ts, email, value });
  }

  // 2ª passada: funde cada BUMP como RECEITA no pedido do CORE do mesmo comprador
  // (o core mais próximo no tempo). 1 pedido = 1 venda → bump não conta venda nova.
  const coresByEmail = new Map();
  cores.forEach((c, idx) => {
    if (!c.email) return;
    if (!coresByEmail.has(c.email)) coresByEmail.set(c.email, []);
    coresByEmail.get(c.email).push(idx);
  });
  let mergedBumps = 0, mergedBumpValue = 0, orphanBumps = 0, orphanBumpValue = 0;
  for (const bp of bumps) {
    const cand = bp.email ? (coresByEmail.get(bp.email) || []) : [];
    if (!cand.length) { orphanBumps++; orphanBumpValue += bp.value; continue; }
    let best = cand[0], bestDt = Infinity;
    for (const idx of cand) { const dt = Math.abs(cores[idx].ts - bp.ts); if (dt < bestDt) { bestDt = dt; best = idx; } }
    cores[best].value += bp.value;
    mergedBumps++; mergedBumpValue += bp.value;
  }

  // 3ª passada: atribuição de cada CORE (venda) pela Detalhe UTM / origem.
  const sales = [];
  const attribution = { ad: 0, adset: 0, campaign: 0, unmatched: 0, none: 0 };
  let trafficSales = 0;
  for (const co of cores) {
    const paid = isPaidSource(co.rawSrc);
    let src = 'organico', m = 'none', c = '', s = '', ad = '';
    if (paid) {
      src = 'meta-ads';
      const rawSck = co.rawDet;
      const segs = sckSegments(rawSck);
      ad = adFromSck(rawSck, segs);
      s  = longestInSck(rawSck, canonSet);
      if (ad) {
        const cc = longestInSck(rawSck, canonCamp) || campForAdSet(fold(ad), fold(s)) || (adToCombo.get(fold(ad)) || {}).c || '';
        c = canonCamp.get(fold(cc)) || cc;
        if (!s) { const combo = adToCombo.get(fold(ad)); if (combo) s = canonSet.get(fold(combo.s)) || combo.s; }
      } else if (s) {
        const cc = longestInSck(rawSck, canonCamp);
        c = canonCamp.get(fold(cc)) || cc;
      } else {
        c = longestInSck(rawSck, canonCamp);
      }
      m = ad ? 'ad' : s ? 'adset' : c ? 'campaign' : 'unmatched';
      trafficSales++;
      attribution[m]++;
    } else {
      // origem não-Meta: guarda um rótulo legível (organico/direto/hotmart_site/…)
      const f = fold(co.rawSrc);
      src = (f && f !== '(none)' && f !== 'none') ? f.replace(/[()]/g, '') : 'organico';
    }
    sales.push({ d: co.d, v: Math.round(co.value * 100) / 100, src, m, c, s, a: ad });
  }
  const salesRows = sales.length;

  // ---------------- Output (reference data.json contract) ----------------
  const allDates = [...ads.map((x) => x.d), ...sales.map((x) => x.d)].sort();
  const now = new Date();
  const nowBR = now.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');

  const warnings = [];
  warnings.push(`Gasto da conta em USD → convertido para BRL a câmbio ×${fxInfo.fx.toFixed(4)} (${fxInfo.source}${fxInfo.date ? ', ' + fxInfo.date : ''}). Sem imposto.`);
  warnings.push(`Vendas filtradas pelo produto (coluna "Produto"): core "${CORE_PRODUCT}"; order bump "${BUMP_PRODUCT}". Faturamento = coluna "Fat. líquido (USD)" (US$ líquido) convertido para R$ a câmbio ×${fxInfo.fx.toFixed(4)}.`);
  if (mergedBumps > 0) warnings.push(`${mergedBumps} order bump "${BUMP_PRODUCT}" somado(s) como faturamento ao pedido do mesmo comprador (US$ ${mergedBumpValue.toFixed(2)}) — não conta(m) como venda nova.`);
  if (orphanBumps > 0) warnings.push(`${orphanBumps} order bump sem pedido core do mesmo e-mail (R$ ${orphanBumpValue.toFixed(2)}) — não incluído(s).`);
  if (skippedStatus > 0) warnings.push(`${skippedStatus} linha(s) do produto com status não aprovado — descartada(s).`);
  if (attribution.none > 0)      warnings.push(`${attribution.none} venda(s) de tráfego sem Detalhe UTM — contam na receita, mas ficam em "Não atribuído".`);
  if (attribution.unmatched > 0) warnings.push(`${attribution.unmatched} venda(s) com Detalhe UTM que não casou com a planilha de anúncios.`);
  if (attribution.adset + attribution.campaign > 0) warnings.push(`${attribution.adset + attribution.campaign} venda(s) casaram só até conjunto/campanha, não até o anúncio.`);
  const nonTraffic = salesRows - trafficSales;
  if (nonTraffic > 0) warnings.push(`${nonTraffic} venda(s) fora do tráfego (origem ≠ Meta) — orgânico/direto; entram só como referência, não no funil/CAC/ROAS.`);

  const out = {
    meta: {
      title: 'EPN — Meta Ads',
      platform: 'Meta Ads',
      traffic_source: 'meta-ads',
      tax: TAX_RATE,
      currency: 'BRL',
      spend_currency: 'USD',
      fx: Math.round(fxInfo.fx * 1e6) / 1e6,
      fx_date: fxInfo.date,
      fx_source: fxInfo.source,
      generated_at: now.toISOString(),
      generated_at_br: nowBR,
      date_min: allDates[0] || null,
      date_max: allDates[allDates.length - 1] || null,
      ads_url: ADS_URL,
      sales_url: BUYERS_URL,
      sales_tab: SALES_TAB,
      counts: {
        ads_rows: ads.length,
        sales_rows: salesRows,
        traffic_sales: trafficSales,
        attribution,
      },
      warnings,
    },
    ads,
    sales,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));

  // Cache-bust: stamp the current build id into index.html.
  try {
    const buildId = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let html = readFileSync('public/index.html', 'utf8');
    html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
    writeFileSync('public/index.html', html);
  } catch (e) { console.warn('BUILD_ID stamp skipped:', e.message); }

  console.log('Wrote public/data.json', out.meta.counts, out.meta.date_min, '→', out.meta.date_max);
  if (ads.length === 0) throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
})().catch((err) => { console.error(err); process.exit(1); });
