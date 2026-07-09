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
