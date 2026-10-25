# Local Model Assessment Operator

A web application for benchmarking local LLMs with [Ollama](https://ollama.com). It measures generation performance and scores responses using a judge model.

## Features

- Dashboard for configuring evaluations and viewing results.
- Live progress updates via Server-Sent Events.
- Persistent evaluation history.
- Sequential model unloading to reduce VRAM usage.

## Quick start

Requires Docker with Compose v2, GNU Make, and Bash. NVIDIA Container Toolkit is required only for GPU mode.

```bash
make prod          # CPU
make prod GPU=1    # NVIDIA GPU
```

Open **http://localhost:5000**. Compose starts both the application and Ollama; a separate Ollama installation is not needed.

Download a candidate model and a judge model:

```bash
docker compose -f compose.base.yaml -f compose.prod.yaml exec ollama ollama pull MODEL_NAME
```

Run the command for each model. To stop the environment:

```bash
make down ENV=prod
```

Run `make help` to list all commands.

## Development

```bash
make dev           # Development server with hot reload (GPU=1 for NVIDIA)
make logs          # Follow logs
make shell         # Open bash in the app container
make down          # Stop the environment
```

Development history is stored in `./history`; production history is stored in a Docker volume.

### Quality checks

Tools and scanners run through Docker; they do not need to be installed on the host.

```bash
make format                           # Fix formatting (changes files)
make test                             # Run tests with coverage
make check                            # Run all checks, no token needed
GH_TOKEN="$(gh auth token)" make ci   # Run exactly what GitHub CI runs
```

Checks never modify source files. `make check` runs zizmor offline; `make ci` adds online workflow audits and requires `GH_TOKEN`. Trivy uses a daily vulnerability database, so an image can start failing without code changes.

### Cleanup

```bash
make clean         # Remove reports and caches
make reset         # Also remove containers and volumes, including production history
```

Ollama models and `./history` are preserved.

### Running without Docker

Requires [uv](https://docs.astral.sh/uv/), and a running Ollama instance:

```bash
uv sync --locked
uv run python app.py
```

For a custom Ollama URL, copy `.env.example` to `.env` and edit `OLLAMA_BASE_URL`. Docker Compose does not require this file.

## CI and releases

Each GitHub Actions job runs one make target: `check-workflows`, `check-code`, or `check-image`. Version tags matching `v*.*.*` run CI, then build a candidate image, verify it with `make test-image`, and publish it to GHCR. Dependabot monitors GitHub Actions, uv, and Docker dependencies.

## License

[MIT](LICENSE)