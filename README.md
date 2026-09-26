# Local Model Assessment Operator

A web application for benchmarking local LLMs with [Ollama](https://ollama.com). It measures generation performance and scores responses using a judge model.

## Features

- Dashboard for configuring evaluations and viewing results.
- Live progress updates via Server-Sent Events.
- Evaluation history stored in a Docker volume.
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

## Development

```bash
make dev           # Development server with hot reload
make dev GPU=1     # Development with NVIDIA GPU
make logs          # Follow development logs
make test          # Run tests with coverage
```

### Quality checks

Tools and scanners run through Docker; they do not need to be installed on the host.

```bash
GH_TOKEN="$(gh auth token)" make ci        # Fix formatting, then run all checks
GH_TOKEN="$(gh auth token)" make ci-check  # Run checks without fixing source
```

Provide `GH_TOKEN` through your environment if you do not use GitHub CLI. `make ci-check` mirrors the CI checks: workflow and shell linting, Ruff, dependency audit, tests, Docker validation, smoke test, and Trivy scan. It may generate coverage reports but does not automatically fix source files.

`make ci` changes Python files. Review `git diff` before committing.

### Running without Docker

Requires Python 3.14, [uv](https://docs.astral.sh/uv/), and a running Ollama instance:

```bash
uv sync --locked
uv run python app.py
```

For a custom Ollama URL, copy `.env.example` to `.env` and edit `OLLAMA_BASE_URL`. Docker Compose does not require this file.

## CI and releases

GitHub Actions runs the same Makefile check targets. Version tags matching `v*.*.*` trigger a CI gate followed by image verification and publication to GHCR. Dependabot monitors GitHub Actions, uv, and Docker dependencies.

## License

[MIT](LICENSE).