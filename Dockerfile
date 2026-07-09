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
