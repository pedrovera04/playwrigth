# naitus-qa-monitor

Microservicio de QA automatizado (Playwright) + orquestación n8n. Detecta errores deterministas
(links rotos, elementos cortados, imágenes rotas, overflow, accesibilidad) en un sitio, en 3
viewports, y opcionalmente complementa con IA de visión (Gemini) para defectos visuales. Solo
notifica issues **nuevos** respecto de la corrida anterior (baseline).

Ver `BRIEF-DESARROLLO.md` para la especificación completa.

## Estructura

```
naitus-qa-monitor/
├── Dockerfile
├── railway.json
├── package.json
├── naitus-qa-monitor.workflow.json   # workflow n8n listo para importar
├── .env.example
└── src/
    ├── server.js        # endpoint HTTP POST /scan
    ├── scanner.js        # crawl + detectores deterministas
    └── cli.js            # scan directo por terminal
```

## 1. Correr localmente

```bash
npm install
npx playwright install chromium
node src/cli.js https://ugm-admision2023.naitus.cl/   # imprime JSON de issues a stdout
```

Para levantar el servidor HTTP:

```bash
QA_API_KEY=dev-token npm start
# GET  http://localhost:3000/health
# POST http://localhost:3000/scan   { "url": "https://..." }  header x-api-key: dev-token
```

## 2. Deploy en Railway

1. Push del repo a GitHub.
2. Railway → **New Project → Deploy from GitHub repo**. Railway detecta el `Dockerfile` y usa
   `railway.json` (builder Dockerfile, healthcheck en `/health`).
3. Variables de entorno del servicio:
   - `QA_API_KEY` — token compartido con n8n (se envía en el header `x-api-key`).
   - `PORT` — la inyecta Railway automáticamente, no hace falta setearla.
4. Verificar: `GET https://TU-SERVICIO.up.railway.app/health` → `{ "ok": true }`.
5. Probar un scan real:

```bash
curl -X POST https://TU-SERVICIO.up.railway.app/scan \
  -H "content-type: application/json" \
  -H "x-api-key: TU_QA_API_KEY" \
  -d '{"url":"https://ugm-admision2023.naitus.cl/","maxPages":10,"maxDepth":1,"screenshots":false}'
```

### Alternativa Cloud Run (mismo Dockerfile)

```bash
gcloud run deploy naitus-qa-monitor \
  --source . --region southamerica-west1 \
  --memory 2Gi --cpu 2 --timeout 3600 \
  --set-env-vars QA_API_KEY=xxxxx --allow-unauthenticated
```

## 3. Integración con n8n

Importar `naitus-qa-monitor.workflow.json` en n8n (**Workflows → Import from File**).

Flujo:

```
Schedule (diario 07:00)
  → Config (Set)             # URLs, keys, viewports por sitio
  → Scan Playwright (HTTP)   # POST al microservicio en Railway
  → IF ¿IA activada?
        ├─ true  → Split screenshots → Gemini Vision (HTTP) → Parse IA → Aggregate AI issues ─┐
        └─ false → Sin IA (passthrough) ────────────────────────────────────────────────────────┤
  → Merge + Baseline (Code)  # junta det + IA, dedup contra la corrida anterior (workflow static data)
  → IF ¿hay issues nuevos?
        → true  → Armar reporte (Code) → Notificar (HTTP → Slack/WhatsApp)
        → false → Sin novedades (NoOp)
```

Editar el nodo **Config** con tus valores reales antes de activar el workflow:

| Campo | Valor |
|---|---|
| `microserviceUrl` | `https://TU-SERVICIO.up.railway.app/scan` |
| `qaApiKey` | mismo `QA_API_KEY` configurado en Railway |
| `targetUrl` | sitio a monitorear |
| `siteName` | nombre corto del sitio (clave del baseline) |
| `aiEnabled` | `true`/`false` — activa la capa Gemini |
| `geminiApiKey` | API key de [Google AI Studio](https://aistudio.google.com/) |
| `notifyUrl` | webhook de Slack (`hooks.slack.com/services/...`) o UltraMsg/Twilio para WhatsApp |

**Notas sobre el workflow:**
- El baseline (Capa 3) usa el *static data* del workflow de n8n — dedup funcional desde el día 1,
  sin depender de Postgres. Persiste mientras no borres/reimportes el workflow. La Tarea 3 del
  roadmap (`BRIEF-DESARROLLO.md` §10) lo reemplaza por PostgreSQL en Railway para multi-sitio real
  y auditoría histórica (`qa_sites`, `qa_issues`, `qa_runs`).
- `Notificar` envía `{"text": "..."}`, compatible directo con **Slack incoming webhooks**. Para
  WhatsApp (UltraMsg/Twilio) ajustar el body en ese nodo al formato que pida el proveedor.
- Multi-sitio (varios `targetUrl`) hoy = duplicar `Config → Scan Playwright → ...` por sitio, o
  reemplazar `Config` por un nodo que liste sitios y loopee (Tarea 4 del roadmap).

## 4. Definición de "hecho" (MVP)

- [x] Microservicio con Dockerfile + `railway.json` listo para deploy en Railway.
- [x] `cli.js` corre localmente contra UGM.
- [x] Workflow n8n (`naitus-qa-monitor.workflow.json`) con Config, scan, IA opcional, baseline y notificación.
- [ ] Confirmar en Railway: `/health` responde `{ "ok": true }` tras el deploy.
- [ ] Importar el workflow en n8n, completar `Config` y activar.
- [ ] Verificar que la segunda corrida sin cambios en el sitio reporta `newCount: 0`.
