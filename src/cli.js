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
