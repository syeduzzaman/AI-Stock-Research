FROM node:24-bookworm-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src
RUN npm run build

FROM python:3.13-slim-bookworm

WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 PORT=8082 LOCAL_CONTAINER_ORIGIN=http://127.0.0.1:8082

COPY backend/requirements.txt ./
RUN pip install --disable-pip-version-check --no-cache-dir -r requirements.txt \
    && groupadd -g 1000 dashboard \
    && useradd -u 1000 -g dashboard --no-create-home dashboard \
    && install -d -o dashboard -g dashboard -m 0700 /app/data \
    && install -o dashboard -g dashboard -m 0600 /dev/null /app/data/.keep

COPY backend/stock_research ./stock_research
COPY --from=frontend /build/dist /app/frontend/dist

USER dashboard
EXPOSE 8082

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os; from urllib.parse import urlsplit; from urllib.request import Request, urlopen; host = urlsplit(os.environ.get('PUBLIC_ORIGIN') or os.environ['LOCAL_CONTAINER_ORIGIN']).netloc; response = urlopen(Request('http://127.0.0.1:' + os.environ['PORT'] + '/healthz', headers={'Host': host}), timeout=4); raise SystemExit(response.status != 200)"]

CMD ["python", "-m", "stock_research"]
