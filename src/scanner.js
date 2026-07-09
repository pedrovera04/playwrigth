// scanner.js — Escaneo determinista de QA con Playwright.
// Detecta errores reales sin IA: links rotos, teléfonos sin tel:, imágenes que no
// cargan, elementos recortados por overflow:hidden, overflow horizontal, consola JS,
// requests fallidos y problemas básicos de accesibilidad. Corre en múltiples viewports.

const { chromium } = require('playwright');

const DEFAULT_VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'laptop-1366', width: 1366, height: 768 }, // aquí se corta el botón del hero
  { name: 'mobile-390', width: 390, height: 844 },
];

// ---------- Detectores que corren dentro del navegador (page.evaluate) ----------

// Elementos visibles recortados por un ancestro con overflow hidden/clip.
// Este es el detector que caza el botón "Ingresa sin PAES" cortado a la mitad.
function detectClipped() {
  const out = [];
  const sel = 'a,button,h1,h2,h3,img,input,[class*="btn"],[class*="button"]';
  document.querySelectorAll(sel).forEach((el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) return;
    let p = el.parentElement;
    while (p) {
      const ps = getComputedStyle(p);
      const ov = ps.overflow + ps.overflowX + ps.overflowY;
      if (/hidden|clip/.test(ov)) {
        const pb = p.getBoundingClientRect();
        const cutBottom = box.bottom - pb.bottom;
        const cutTop = pb.top - box.top;
        const cutRight = box.right - pb.right;
        const cutLeft = pb.left - box.left;
        const cut = Math.max(cutBottom, cutTop, cutRight, cutLeft);
        if (cut > 3) {
          out.push({
            type: 'clipped_element',
            severity: 'high',
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('alt') || '').trim().slice(0, 80),
            clippedPx: Math.round(cut),
            className: (el.className || '').toString().slice(0, 120),
          });
        }
        break; // el primer ancestro que recorta es el culpable
      }
      p = p.parentElement;
    }
  });
  return out;
}

// Links cuyo TEXTO es un teléfono o mail pero el href NO usa tel:/mailto:/http.
// Esto es exactamente el bug del footer: "600-401-0060" con href="6004010060" → 404.
function detectBadContactLinks() {
  const out = [];
  const phoneRe = /(\+?\d[\d\s().-]{6,}\d)/;
  const mailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  document.querySelectorAll('a').forEach((a) => {
    const text = (a.innerText || '').trim();
    const href = a.getAttribute('href') || '';
    const scheme = /^(tel:|mailto:|https?:|#|\/|javascript:)/i;
    if (phoneRe.test(text) && !/^(tel:)/i.test(href)) {
      // Es un teléfono en el texto y NO es un link tel: → link roto o mal enlazado.
      if (!/^(tel:)/i.test(href)) {
        out.push({
          type: 'phone_not_tel_link',
          severity: 'high',
          text,
          href,
          resolved: a.href, // cómo lo resuelve el browser (aquí verás el 404)
          hint: href && !scheme.test(href)
            ? 'href sin esquema: el browser lo resuelve como ruta relativa (404)'
            : 'debería ser href="tel:+56..."',
        });
      }
    }
    if (mailRe.test(text) && !/^mailto:/i.test(href)) {
      out.push({ type: 'email_not_mailto_link', severity: 'medium', text, href, resolved: a.href });
    }
  });
  return out;
}

// Imágenes que no cargaron (roto) o sin alt (accesibilidad).
function detectImages() {
  const out = [];
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src || '';
    if (img.complete && img.naturalWidth === 0) {
      out.push({ type: 'image_broken', severity: 'high', src });
    }
    if (!img.getAttribute('alt') && !img.getAttribute('aria-hidden')) {
      out.push({ type: 'image_missing_alt', severity: 'low', src });
    }
  });
  return out;
}

// Overflow horizontal (scroll lateral no deseado), típico en móvil.
function detectHorizontalOverflow() {
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 2) {
    // intenta ubicar los elementos que se salen del viewport
    const offenders = [];
    const vw = doc.clientWidth;
    document.querySelectorAll('*').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right > vw + 4 && b.width > 8 && b.width < 4000) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          className: (el.className || '').toString().slice(0, 80),
          overflowPx: Math.round(b.right - vw),
        });
      }
    });
    return [{
      type: 'horizontal_overflow',
      severity: 'medium',
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      offenders: offenders.slice(0, 5),
    }];
  }
  return [];
}

// Accesibilidad básica: inputs sin label, links/botones sin texto accesible.
function detectA11yBasics() {
  const out = [];
  document.querySelectorAll('input:not([type="hidden"]),select,textarea').forEach((el) => {
    const id = el.id;
    const hasLabel =
      (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
      el.closest('label') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.getAttribute('placeholder');
    if (!hasLabel) {
      out.push({ type: 'input_no_label', severity: 'medium', name: el.name || el.id || el.type });
    }
  });
  document.querySelectorAll('a,button').forEach((el) => {
    const txt = (el.innerText || '').trim();
    const aria = el.getAttribute('aria-label') || el.querySelector('img[alt]');
    if (!txt && !aria) {
      out.push({ type: 'link_no_accessible_text', severity: 'low', html: el.outerHTML.slice(0, 100) });
    }
  });
  return out;
}

// Recolecta todos los links internos/externos para validación de status fuera del page.
function collectLinks() {
  const seen = new Set();
  const links = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (seen.has(href)) return;
    seen.add(href);
    links.push({ href, text: (a.innerText || '').trim().slice(0, 60) });
  });
  return links;
}

// ---------- Orquestación por página ----------

async function scanPage(context, url, viewports, wantScreenshots) {
  const results = { url, viewports: [], links: [], consoleErrors: [], failedRequests: [] };
  const consoleErrors = [];
  const failedRequests = [];

  const page = await context.newPage();

  page.on('pageerror', (err) => consoleErrors.push({ type: 'page_error', message: String(err).slice(0, 300) }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ type: 'console_error', message: msg.text().slice(0, 300) });
  });
  page.on('response', (res) => {
    const s = res.status();
    if (s >= 400) failedRequests.push({ url: res.url(), status: s });
  });

  try {
    // domcontentloaded es confiable incluso en sitios con actividad de red
    // constante (analytics, chat widgets) que nunca dejan la red en "idle".
    // networkidle se intenta aparte, best-effort, sin bloquear el scan si no llega.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (e) {
    await page.close();
    return { url, error: `goto_failed: ${String(e).slice(0, 200)}`, viewports: [], links: [] };
  }

  // Un pase por cada viewport: detecta lo dependiente de layout.
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(600); // deja re-fluir el layout / lazy render

    const vpIssues = [];
    for (const fn of [detectClipped, detectBadContactLinks, detectImages, detectHorizontalOverflow, detectA11yBasics]) {
      try {
        const found = await page.evaluate(fn);
        found.forEach((f) => vpIssues.push({ ...f, viewport: vp.name }));
      } catch (e) {
        vpIssues.push({ type: 'detector_error', severity: 'low', detector: fn.name, message: String(e).slice(0, 150), viewport: vp.name });
      }
    }

    let screenshot = null;
    if (wantScreenshots) {
      const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
      screenshot = buf.toString('base64');
    }

    results.viewports.push({ name: vp.name, width: vp.width, height: vp.height, issues: vpIssues, screenshot });
  }

  results.links = await page.evaluate(collectLinks);
  results.consoleErrors = consoleErrors;
  results.failedRequests = failedRequests;

  await page.close();
  return results;
}

// Valida status HTTP de los links recolectados (aquí cae el 404 del teléfono).
async function checkLinks(context, links, baseHost) {
  const broken = [];
  const limit = 40; // no reventar el server destino
  const slice = links.slice(0, 200);
  for (let i = 0; i < slice.length; i += limit) {
    const batch = slice.slice(i, i + limit);
    await Promise.all(
      batch.map(async (l) => {
        try {
          const resp = await context.request.get(l.href, { timeout: 15000, maxRedirects: 5 });
          const s = resp.status();
          if (s >= 400) {
            const internal = (() => { try { return new URL(l.href).host === baseHost; } catch { return false; } })();
            broken.push({ type: 'broken_link', severity: s >= 500 ? 'high' : 'medium', href: l.href, text: l.text, status: s, internal });
          }
        } catch (e) {
          broken.push({ type: 'broken_link', severity: 'medium', href: l.href, text: l.text, status: 'unreachable', message: String(e).slice(0, 120) });
        }
      })
    );
  }
  return broken;
}

// ---------- Crawl same-domain (BFS) ----------

async function crawl(startUrl, opts) {
  const { maxPages = 25, maxDepth = 2, viewports = DEFAULT_VIEWPORTS, screenshots = false } = opts || {};
  const startHost = new URL(startUrl).host;
  const queue = [{ url: startUrl, depth: 0 }];
  const visited = new Set();
  const pages = [];

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'NaitusQA/1.0 (+https://naitus.cl)' });

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, depth } = queue.shift();
      const norm = url.split('#')[0];
      if (visited.has(norm)) continue;
      visited.add(norm);

      const res = await scanPage(context, norm, viewports, screenshots);
      res.brokenLinks = await checkLinks(context, res.links || [], startHost);
      pages.push(res);

      if (depth < maxDepth) {
        for (const l of res.links || []) {
          try {
            const u = new URL(l.href);
            if (u.host === startHost && !visited.has(u.href.split('#')[0])) {
              queue.push({ url: u.href, depth: depth + 1 });
            }
          } catch { /* ignore */ }
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return flatten(startUrl, pages);
}

// Aplana todo a una lista única de issues con id estable (hash) para dedup en baseline.
function flatten(startUrl, pages) {
  const issues = [];
  // Varios elementos (ej. iconos repetidos sin alt) pueden compartir el mismo
  // hash base cuando no hay texto/src/href que los distinga. Se desambiguan
  // con un sufijo por orden de aparicion, para que el id siga siendo unico
  // dentro de la corrida y el dedup del baseline no los trate como uno solo.
  const seenCounts = new Map();
  const push = (page, extra) => {
    const base = hashIssue(page, extra);
    const n = (seenCounts.get(base) || 0) + 1;
    seenCounts.set(base, n);
    const id = n === 1 ? base : `${base}_${n}`;
    issues.push({ page, ...extra, id });
  };

  for (const p of pages) {
    if (p.error) { push(p.url, { type: 'page_load_error', severity: 'high', message: p.error }); continue; }
    for (const vp of p.viewports || []) {
      for (const iss of vp.issues || []) push(p.url, iss);
    }
    for (const b of p.brokenLinks || []) push(p.url, b);
    for (const c of p.consoleErrors || []) push(p.url, { ...c, severity: 'medium' });
    for (const f of p.failedRequests || []) push(p.url, { type: 'failed_request', severity: f.status >= 500 ? 'high' : 'medium', ...f });
  }

  const screenshots = [];
  for (const p of pages) for (const vp of p.viewports || []) {
    if (vp.screenshot) screenshots.push({ page: p.url, viewport: vp.name, width: vp.width, height: vp.height, jpegBase64: vp.screenshot });
  }

  const summary = issues.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {});
  return {
    target: startUrl,
    scannedAt: new Date().toISOString(),
    pagesScanned: pages.length,
    totalIssues: issues.length,
    summary,
    issues,
    screenshots, // se los pasa la capa de IA en n8n
  };
}

function hashIssue(page, extra) {
  const key = `${page}|${extra.type}|${extra.viewport || ''}|${extra.href || extra.src || extra.text || extra.message || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = (h * 31 + key.charCodeAt(i)) | 0; }
  return 'iss_' + (h >>> 0).toString(16);
}

module.exports = { crawl, DEFAULT_VIEWPORTS };
