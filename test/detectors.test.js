// detectors.test.js — Fixtures HTML locales que reproducen cada tipo de issue.
// Sirve test/fixtures/ con un server estático y corre el scanner contra localhost:
// más rápido y determinista que probar contra un sitio real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { crawl } = require('../src/scanner');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const VIEWPORTS = [{ name: 'test-1280', width: 1280, height: 800 }];

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(FIXTURES_DIR, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function scanFixture(name) {
  const result = await crawl(`${baseUrl}/${name}`, {
    maxPages: 1,
    maxDepth: 0,
    viewports: VIEWPORTS,
    screenshots: false,
  });
  return result.issues;
}

test('detectClipped: caso positivo — botón cortado por overflow:hidden', async () => {
  const issues = await scanFixture('clipped-button.html');
  const found = issues.find((i) => i.type === 'clipped_element');
  assert.ok(found, 'debería detectar clipped_element');
  assert.equal(found.severity, 'high');
  assert.match(found.text, /Ingresa sin PAES/);
});

test('detectClipped: caso negativo — botón no cortado no genera issue', async () => {
  const issues = await scanFixture('clean.html');
  const found = issues.find((i) => i.type === 'clipped_element');
  assert.equal(found, undefined);
});

test('detectBadContactLinks: caso positivo — teléfono sin tel:', async () => {
  const issues = await scanFixture('phone-link.html');
  const found = issues.find((i) => i.type === 'phone_not_tel_link');
  assert.ok(found, 'debería detectar phone_not_tel_link');
  assert.equal(found.text, '600-401-0060');
  assert.equal(found.href, '6004010060');
});

test('detectBadContactLinks: caso negativo — tel:/mailto: correctos no generan issue', async () => {
  const issues = await scanFixture('clean.html');
  assert.equal(issues.find((i) => i.type === 'phone_not_tel_link'), undefined);
  assert.equal(issues.find((i) => i.type === 'email_not_mailto_link'), undefined);
});

test('detectImages: caso positivo — imagen rota', async () => {
  const issues = await scanFixture('image-broken.html');
  const found = issues.find((i) => i.type === 'image_broken');
  assert.ok(found, 'debería detectar image_broken');
});

test('detectImages: caso negativo — imagen con alt que carga no genera issue', async () => {
  const issues = await scanFixture('clean.html');
  assert.equal(issues.find((i) => i.type === 'image_broken'), undefined);
  assert.equal(issues.find((i) => i.type === 'image_missing_alt'), undefined);
});

test('detectHorizontalOverflow: caso positivo — contenido más ancho que el viewport', async () => {
  const issues = await scanFixture('overflow.html');
  const found = issues.find((i) => i.type === 'horizontal_overflow');
  assert.ok(found, 'debería detectar horizontal_overflow');
});

test('detectHorizontalOverflow: caso negativo — página sin overflow no genera issue', async () => {
  const issues = await scanFixture('clean.html');
  assert.equal(issues.find((i) => i.type === 'horizontal_overflow'), undefined);
});

test('detectA11yBasics: caso positivo — input sin label y botón sin texto', async () => {
  const issues = await scanFixture('a11y.html');
  assert.ok(issues.find((i) => i.type === 'input_no_label'));
  assert.ok(issues.find((i) => i.type === 'link_no_accessible_text'));
});

test('detectA11yBasics: caso negativo — input etiquetado y botón con texto no generan issue', async () => {
  const issues = await scanFixture('clean.html');
  assert.equal(issues.find((i) => i.type === 'input_no_label'), undefined);
  assert.equal(issues.find((i) => i.type === 'link_no_accessible_text'), undefined);
});

test('flatten: cada issue tiene un id estable', async () => {
  const issues = await scanFixture('clipped-button.html');
  for (const iss of issues) {
    assert.match(iss.id, /^iss_[0-9a-f]+$/);
  }
});

test('flatten: elementos idénticos sin distintivo (mismo src/type/viewport) generan ids únicos', async () => {
  const issues = await scanFixture('repeated-icons.html');
  const missingAlt = issues.filter((i) => i.type === 'image_missing_alt');
  assert.equal(missingAlt.length, 3, 'las 3 imágenes repetidas deben detectarse');
  const ids = missingAlt.map((i) => i.id);
  assert.equal(new Set(ids).size, 3, 'cada una debe tener un id distinto');
  assert.match(ids[1], /^iss_[0-9a-f]+_2$/);
  assert.match(ids[2], /^iss_[0-9a-f]+_3$/);
});
