# Naitus — Monitor QA de Sitios · Brief de Desarrollo

> Documento de especificación para desarrollo con Claude Code.
> Objetivo: construir un sistema de monitoreo automático de QA que detecte errores en sitios web (rotura de links, elementos cortados, imágenes que no cargan, overflow, accesibilidad y defectos visuales) y notifique solo lo nuevo. Reusable como servicio multi-cliente de Naitus.

---

## 1. Contexto y motivación

El disparador es el sitio de UGM (`https://ugm-admision2023.naitus.cl/`, WordPress + tema custom `admision-ugm`). Se detectaron dos bugs representativos de dos familias distintas de error:

1. **Botón del hero cortado a la mitad** ("Ingresa sin PAES"). Causa: el slide del hero tiene altura fija y el bloque de texto/botón se desborda; un ancestro con `overflow:hidden` lo recorta. Es un bug **dependiente del aspect-ratio** (se ve en laptop ~1366×768, no en pantallas altas).
2. **Teléfono del footer que lleva a 404.** El texto es `600-401-0060` pero el `href` es `6004010060` (sin esquema `tel:`), así que el browser lo resuelve como ruta relativa → 404.

Estas dos familias definen la estrategia: **la mayoría de los errores son deterministas y NO requieren IA.** La IA se usa solo como capa complementaria para defectos visuales que no se pueden expresar como regla.

### Principio rector
- **Capa 1 (determinista, Playwright):** reglas. Barata, confiable, cero falsos positivos. Cubre los dos bugs de arriba y muchos más.
- **Capa 2 (IA de visión, Gemini):** red de seguridad para lo "estéticamente roto". Sus hallazgos son *sugerencias a revisar*, no verdad.
- **Capa 3 (baseline):** solo notificar issues nuevos, para no spamear con los mismos errores en cada corrida.

---

## 2. Decisión de arquitectura (LEER ANTES DE CODEAR)

**Dos piezas separadas:**

```
┌─────────────────────┐        HTTP POST /scan        ┌──────────────────────────┐
│   n8n (Cloud)       │ ────────────────────────────▶ │  Microservicio Playwright │
│  orquestación       │ ◀──────────────────────────── │  (Docker, always-on)      │
│  IA + dedup + notif │        JSON de issues          │  Railway / Cloud Run      │
└─────────────────────┘                                └──────────────────────────┘
```

**Por qué separado y no todo en n8n:** n8n Cloud no puede instalar navegadores ni paquetes npm arbitrarios. El navegador tiene que vivir en un contenedor propio.

**Por qué NO Vercel para el microservicio:** es serverless (request/response) con tope de duración y billing por CPU activa. Un crawl con navegador headless es un proceso largo y CPU-intensivo → va a contrapelo del modelo. Además el Chromium bundleado no cabe en una función (habría que usar `playwright-core` + `@sparticuz/chromium`).

**Hosting recomendado del microservicio:** contenedor always-on. Opciones válidas con el mismo `Dockerfile`:
- **Railway** — menor fricción (stack habitual de Naitus).
- **Google Cloud Run** — serverless de contenedores, escala a cero, timeout largo (hasta 60 min); más barato para scans esporádicos.
- Render / Fly.io / VPS (Hetzner) — equivalentes.

---

## 3. Stack

| Componente | Tecnología |
|---|---|
| Navegador headless | Playwright (`chromium`) |
| Servidor HTTP | Express |
| Runtime | Node.js ≥ 18 |
| Contenedor | Docker (imagen oficial `mcr.microsoft.com/playwright`) |
| Orquestación | n8n (Cloud) |
| IA de visión | Google Gemini (`gemini-2.0-flash`) |
| Persistencia baseline (roadmap) | PostgreSQL (Railway) |
| Notificación | Webhook → UltraMsg/Twilio (WhatsApp) o Slack |

---

## 4. Estructura del proyecto

```
naitus-qa-monitor/
├── Dockerfile
├── package.json
├── README.md
├── .env.example
└── src/
    ├── server.js        # endpoint HTTP /scan
    ├── scanner.js       # crawl + detectores deterministas
    ├── cli.js           # scan directo por terminal
    └── db.js            # (ROADMAP) baseline en Postgres
```

---

## 5. Especificación de detectores (Capa 1 — determinista)

Todos corren en **3 viewports** (1920×1080, 1366×768, 390×844) y reportan en cuál falla cada issue.

| Detector (`type`) | Qué detecta | Severidad | Cubre bug |
|---|---|---|---|
| `clipped_element` | Elemento visible recortado por ancestro con `overflow:hidden/clip` | high | **Botón hero cortado** |
| `phone_not_tel_link` | Texto es teléfono pero `href` no es `tel:` | high | **Teléfono footer 404** |
| `email_not_mailto_link` | Texto es email pero `href` no es `mailto:` | medium | |
| `broken_link` | `<a>` que responde 4xx/5xx | high/medium | teléfono footer también |
| `image_broken` | `<img>` con `naturalWidth===0` | high | |
| `image_missing_alt` | `<img>` sin `alt` | low | |
| `horizontal_overflow` | `scrollWidth > clientWidth` (scroll lateral) | medium | |
| `console_error` / `page_error` | Errores JS en consola | medium | |
| `failed_request` | Requests de red 4xx/5xx | high/medium | |
| `input_no_label` | Input sin label/aria-label/placeholder | medium | |
| `link_no_accessible_text` | Link/botón sin texto accesible | low | |

**Requisito clave:** cada issue lleva un `id` = hash estable de `(page, type, viewport, href/src/text)`. Es la base del dedup en la Capa 3.

**Contrato de salida del endpoint** (`POST /scan`):

```json
{
  "target": "https://...",
  "scannedAt": "ISO-8601",
  "pagesScanned": 12,
  "totalIssues": 34,
  "summary": { "high": 5, "medium": 20, "low": 9 },
  "issues": [ { "id": "iss_1a2b", "page": "...", "type": "clipped_element", "severity": "high", "viewport": "laptop-1366", "text": "...", "clippedPx": 22 } ],
  "screenshots": [ { "page": "...", "viewport": "laptop-1366", "width": 1366, "height": 768, "jpegBase64": "..." } ],
  "durationMs": 41230
}
```

---

## 6. Código de referencia

> Implementación ya validada (syntax-check OK). Claude Code puede tomarla tal cual y extenderla según el roadmap (§10). No reinventar los detectores; sí mejorar cobertura y agregar tests.

### 6.1 `package.json`
```json
{
  "name": "naitus-qa-monitor",
  "version": "1.0.0",
  "description": "Microservicio Playwright de QA automatizado para sitios (Naitus). Detecta links rotos, elementos cortados, imágenes que no cargan, overflow y accesibilidad, en múltiples viewports.",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "scan": "node src/cli.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "playwright": "^1.48.0"
  },
  "engines": {
    "node": ">=18"
  }
}

```

### 6.2 `Dockerfile`
```dockerfile
# Imagen oficial de Playwright: ya trae Chromium + todas las libs del SO.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
# QA_API_KEY y PORT se definen como variables de entorno en Railway.
EXPOSE 3000

CMD ["node", "src/server.js"]

```

### 6.3 `src/scanner.js`
```javascript
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
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
  const push = (page, extra) => issues.push({ page, ...extra, id: hashIssue(page, extra) });

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

```

### 6.4 `src/server.js`
```javascript
// server.js — Envuelve el scanner en un endpoint HTTP que n8n llama.
// POST /scan  { url, viewports?, maxPages?, maxDepth?, screenshots? }
// Protegido con un token simple en header x-api-key (defínelo en Railway).

const express = require('express');
const { crawl, DEFAULT_VIEWPORTS } = require('./scanner');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.QA_API_KEY || '';

app.get('/health', (_req, res) => res.json({ ok: true, service: 'naitus-qa-monitor' }));

app.post('/scan', async (req, res) => {
  if (API_KEY && req.header('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const {
    url,
    viewports = DEFAULT_VIEWPORTS,
    maxPages = 25,
    maxDepth = 2,
    screenshots = true,
  } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url inválida; incluye http(s)://' });
  }

  const t0 = Date.now();
  try {
    const result = await crawl(url, { viewports, maxPages, maxDepth, screenshots });
    result.durationMs = Date.now() - t0;
    res.json(result);
  } catch (e) {
    console.error('scan_failed', e);
    res.status(500).json({ error: 'scan_failed', message: String(e).slice(0, 300) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`QA monitor escuchando en :${port}`));

```

### 6.5 `src/cli.js`
```javascript
// cli.js — Corre un scan directo desde la terminal:
//   node src/cli.js https://ugm-admision2023.naitus.cl/
// Escribe el resultado (sin screenshots) a stdout como JSON.

const { crawl } = require('./scanner');

(async () => {
  const url = process.argv[2] || 'https://ugm-admision2023.naitus.cl/';
  const result = await crawl(url, { maxPages: 10, maxDepth: 1, screenshots: false });
  // sin screenshots en CLI para no ensuciar la salida
  delete result.screenshots;
  console.log(JSON.stringify(result, null, 2));
})();

```

### 6.6 `.env.example` (crear)
```
QA_API_KEY=cambia-esto-por-un-token-largo
PORT=3000
```

---

## 7. Deploy del microservicio (Railway)

1. Push del repo a GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**. Detecta el `Dockerfile` automáticamente.
3. Variables de entorno:
   - `QA_API_KEY` = token compartido con n8n (header `x-api-key`).
   - `PORT` lo inyecta Railway.
4. Verificar: `GET https://TU-SERVICIO.up.railway.app/health` → `{ "ok": true }`.

**Prueba local antes de deploy:**
```bash
npm install
npx playwright install chromium
node src/cli.js https://ugm-admision2023.naitus.cl/   # imprime JSON de issues
```

**Alternativa Cloud Run** (mismo Dockerfile):
```bash
gcloud run deploy naitus-qa-monitor \
  --source . --region southamerica-west1 \
  --memory 2Gi --cpu 2 --timeout 3600 \
  --set-env-vars QA_API_KEY=xxxxx --allow-unauthenticated
```
(2Gi de memoria mínimo: Chromium es pesado.)

---

## 8. Integración con n8n

Importar el workflow provisto (`naitus-qa-monitor.workflow.json`) o reconstruirlo con este flujo:

```
Schedule (diario 07:00)
  → Config (Set)            # URLs, keys, viewports por sitio
  → Scan Playwright (HTTP)  # POST al microservicio
  → IF ¿IA activada?
        ├─ true → Split screenshots → Gemini Vision (HTTP) → Parse IA ─┐
        └─ false ──────────────────────────────────────────────────────┤
  → Merge + Baseline (Code) # junta det + IA, dedup vs static data
  → IF ¿hay issues nuevos?
        → Armar reporte (Code)
        → Notificar (HTTP → WhatsApp/Slack)
```

**Nodo Config — campos a reemplazar:**

| Campo | Valor |
|---|---|
| `microserviceUrl` | `https://TU-SERVICIO.up.railway.app/scan` |
| `qaApiKey` | mismo `QA_API_KEY` de Railway |
| `targetUrl` | sitio a monitorear |
| `geminiApiKey` | API key de Gemini (si `aiEnabled=true`) |
| `notifyUrl` | webhook UltraMsg/Twilio/Slack |

---

## 9. Capa IA (Gemini Vision)

- Se manda un screenshot full-page por viewport.
- Prompt: rol de QA de UI, salida **exclusivamente JSON array**, `temperature: 0`.
- Cada item: `{ tipo, descripcion, ubicacion, severidad }`.
- Parseo defensivo: quitar los fences de markdown que a veces mete el modelo, envolver en `try/catch`; si no es JSON válido → ignorar (no meter ruido).
- Tratar como sugerencias. **Para bajar falsos positivos (roadmap):** pipeline de 2 etapas — detectar en screenshot completo, recortar región sospechosa, re-preguntar para confirmar.

---

## 10. Roadmap de tareas para Claude Code

Ordenadas por prioridad. Cada una es un PR independiente.

### Tarea 1 — Scaffold y verificación base ✅ (código de referencia listo)
- Levantar repo con la estructura de §4, correr `cli.js` contra UGM y confirmar que aparecen `clipped_element` y `phone_not_tel_link`/`broken_link`.
- **Criterio de aceptación:** el JSON de salida incluye ambos bugs conocidos en el viewport `laptop-1366`.

### Tarea 2 — Tests unitarios de detectores
- Fixtures HTML mínimos (páginas de prueba servidas localmente) que reproduzcan cada tipo de issue.
- Framework sugerido: `node:test` + Playwright contra un server estático local.
- **Criterio:** cada detector tiene al menos 1 caso positivo y 1 negativo.

### Tarea 3 — Baseline en PostgreSQL (reemplaza static data)
- Crear `src/db.js` con pool a Postgres (Railway). Schema:
```sql
CREATE TABLE qa_sites (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  viewports JSONB,
  ai_enabled BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true
);
CREATE TABLE qa_issues (
  id TEXT PRIMARY KEY,           -- hash del issue
  site_id INT REFERENCES qa_sites(id),
  type TEXT, severity TEXT, viewport TEXT,
  page TEXT, detail JSONB,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE qa_runs (
  id SERIAL PRIMARY KEY,
  site_id INT REFERENCES qa_sites(id),
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  total INT, nuevos INT, resueltos INT
);
```
- Lógica: al recibir un scan, upsert de issues (marcar `last_seen`), detectar nuevos (no existían), marcar resueltos (`resolved_at` a los que ya no aparecen), registrar el run.
- **Criterio:** dos corridas seguidas sin cambios en el sitio → segunda corrida reporta 0 nuevos.

### Tarea 4 — Config multi-sitio
- Endpoint `POST /scan` acepta `siteName`; el microservicio lee config de `qa_sites`.
- En n8n: nodo que lista sitios activos y hace loop (un scan por sitio).
- **Criterio:** agregar un sitio nuevo = insertar fila en `qa_sites`, sin tocar el workflow.

### Tarea 5 — Aserciones por sitio (reglas custom)
- Permitir reglas específicas por cliente, ej: "el header debe tener exactamente 1 CTA primario", "el footer debe tener un `tel:` válido".
- Formato declarativo en `qa_sites.assertions` (JSONB), evaluado en el navegador.
- **Criterio:** una aserción fallida genera un issue con `type: 'assertion_failed'`.

### Tarea 6 — Dashboard (opcional)
- Vista web (Angular/React, stack Naitus) que lee `qa_runs`/`qa_issues`: histórico por sitio, severidad, screenshots, estado (nuevo/persistente/resuelto).

---

## 11. Convenciones y notas

- **No sobre-usar IA:** cualquier error expresable como regla va en Capa 1, no en Gemini.
- **Siempre multi-viewport:** bugs como el del hero solo aparecen en cierto aspect-ratio.
- **Rate limiting al validar links:** batches (`checkLinks` usa lotes de 40) para no reventar el sitio destino.
- **Screenshots en JPEG q60** para no inflar el payload a Gemini/n8n.
- **Seguridad:** `QA_API_KEY` obligatoria en producción; no exponer el microservicio sin auth.
- **Idempotencia:** el `id` de issue debe ser estable entre corridas o el dedup se rompe (no incluir timestamps ni valores volátiles en el hash).

---

## 12. Definición de "hecho" (MVP)

- [ ] Microservicio desplegado en Railway/Cloud Run, `/health` responde.
- [ ] `cli.js` detecta los 2 bugs conocidos de UGM.
- [ ] Workflow n8n importado y corriendo con Config de UGM.
- [ ] Baseline funcionando (segunda corrida sin cambios → 0 nuevos).
- [ ] Notificación llega por WhatsApp/Slack solo con issues nuevos.
