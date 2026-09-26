FROM python:3.14.4-slim AS base

# OS security patches from Debian's point release; exact package/version pins break on the next point-release.
# hadolint ignore=DL3008
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Patches the base image's bundled system pip and setuptools (unused at runtime — venv is what runs), just to clear Trivy findings.
# hadolint ignore=DL3013
RUN python -m pip install --no-cache-dir --upgrade pip setuptools

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app


FROM base AS builder

# Build-only dep, discarded after this stage; pinning exact debian package/version breaks on the next point-release.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv

COPY requirements.txt .
# Bootstrapping pip itself; app deps are pinned via -r requirements.txt below.
# hadolint ignore=DL3013
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt


FROM builder AS dev

COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt

COPY . .

CMD ["flask", "run", "--host=0.0.0.0", "--port=5000"]


FROM base AS production

RUN groupadd -r appuser && useradd -r -m -g appuser appuser

COPY --from=builder /opt/venv /opt/venv

# Runtime never invokes system pip/setuptools/ensurepip — only /opt/venv runs. Stripping them
# removes their CVEs entirely (incl. pip's vendored msgpack/pkg_resources), instead of
# chasing upstream patches for tooling the app never touches.
RUN rm -rf /usr/local/lib/python3.14/site-packages/pip* \
           /usr/local/lib/python3.14/site-packages/setuptools* \
           /usr/local/lib/python3.14/site-packages/pkg_resources \
           /usr/local/lib/python3.14/ensurepip \
           /usr/local/bin/pip*

COPY core/ /app/core/
COPY static/ /app/static/
COPY templates/ /app/templates/
COPY app.py /app/

RUN mkdir -p /app/history && \
    chown -R appuser:appuser /app/history && \
    chmod -R 775 /app/history && \
    chmod -R 755 /app

ENV HOME=/home/appuser

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/health')" || exit 1

CMD ["gunicorn", \
     "--workers", "1", \
     "--threads", "4", \
     "--worker-tmp-dir", "/dev/shm", \
     "--bind", "0.0.0.0:5000", \
     "app:app"]