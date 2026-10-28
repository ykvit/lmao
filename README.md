<div align="center">

<img src="docs/assets/logo.svg" alt="lmao logo" width="120">

# lmao

**Local Model Assessment Operator**

Benchmark local LLMs with [Ollama](https://ollama.com): blind grading against a reference, plus speed, ending in a recommendation.

[![Release build](https://img.shields.io/github/actions/workflow/status/ykvit/lmao/release.yml?branch=main&style=flat-square&label=build)](https://github.com/ykvit/lmao/actions/workflows/release.yml)
[![Security](https://img.shields.io/github/actions/workflow/status/ykvit/lmao/security.yml?branch=main&style=flat-square&label=security)](https://github.com/ykvit/lmao/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/ykvit/lmao?style=flat-square)](https://github.com/ykvit/lmao/releases)
[![Python](https://img.shields.io/badge/python-3.14-3776AB?style=flat-square&logo=python&logoColor=white)](pyproject.toml)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json&style=flat-square)](https://docs.astral.sh/ruff/)
[![License: MIT](https://img.shields.io/github/license/ykvit/lmao?style=flat-square)](LICENSE)

</div>

## How it works

1. The judge writes a reference answer for each question (or you provide one).
2. Every candidate answers each question once, one model in VRAM at a time. Thinking is off, answers are capped at 500 words and 1000 tokens.
3. The judge grades each answer separately and blind (no model names) against the reference: 0-100 in five bands, 70+ is a pass.
4. Python computes median, pass rate, fails, errors and speed, then recommends the fastest model with a pass rate of at least 80%, otherwise the best median. The judge only writes the summary.

**Cloud judge** (off by default): tick it in the UI to use an Ollama cloud model as the judge. Grading then runs in parallel with generation. Prompts and answers leave your machine, see [SECURITY.md](SECURITY.md).

## Quick start

Requires Docker with Compose v2, GNU Make and Bash. NVIDIA Container Toolkit is needed only for GPU mode.

```bash
make prod            # CPU
make prod GPU=1      # NVIDIA GPU
```

Open **http://localhost:5001**. Compose starts the app and Ollama together. Pull a candidate and a judge model (use `compose.dev.yaml` instead of `compose.prod.yaml` in dev):

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec ollama ollama pull MODEL_NAME
```

Stop with `make down ENV=prod`. Run `make help` to list all commands.

Results are saved in `./history` (dev) or the `history_data` Docker volume (prod).

## Development

```bash
make dev                              # hot reload on http://localhost:5000
make test                             # tests with coverage
GH_TOKEN="$(gh auth token)" make ci   # everything GitHub CI runs
```

Without Docker you need [uv](https://docs.astral.sh/uv/) and a running Ollama (`OLLAMA_BASE_URL`, see `.env.example`):

```bash
uv sync --locked && uv run python app.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commits, branches, PRs and releases.

## License

[MIT](LICENSE)