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

To change the Python version, update the `FROM python:` line in the `Dockerfile` and `requires-python` in `pyproject.toml` together; `make check-python` verifies they agree.
Requires [uv](https://docs.astral.sh/uv/), and a running Ollama instance:

```bash
uv sync --locked
uv run python app.py
```

For a custom Ollama URL, copy `.env.example` to `.env` and edit `OLLAMA_BASE_URL`. Docker Compose does not require this file.

## CI and releases

Pull requests run `check-workflows`, `check-code` and `check-image`, one make target per job. A push to `main` runs the Release workflow: it repeats the code checks, builds the production image once, and tests that exact image (smoke test and Trivy scan).

A release happens when `version` in `pyproject.toml` has no git tag yet. The tested image is then copied to GHCR with the same digest and attested, and the GitHub Release creates the tag `vX.Y.Z`. A push without a version change publishes nothing.

### Releasing

```bash
git switch -c chore/bump-X.Y.Z
make bump PART=patch        # patch | minor | major
git commit -am "chore: bump version to X.Y.Z"
```

Open a PR and merge it. Merging a version bump releases that version, so keep it separate from other changes. `make release-plan` shows which tag the current version would publish.

Prereleases use `make bump PART="patch rc"` (`1.2.3rc1` is published as `v1.2.3-rc.1`) and get only their exact image tag, without floating major or minor tags. `make bump PART=stable` turns a prerelease into the final version.

Dependabot monitors GitHub Actions, uv, Docker images, and the CI tool images in `docker/tools.Dockerfile`.

## License

[MIT](LICENSE)