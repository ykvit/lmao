# Local Model Assessment Operator

Automated benchmarking and qualitative evaluation for local Large Language Models.

The Local Model Assessment Operator provides a robust framework for evaluating LLMs running on [Ollama](https://ollama.com). It measures technical performance (tokens/sec) alongside intellectual quality using a "Judge-LLM" scoring system.

## Key Features

* 3-Panel Dashboard: Unified interface for configuration, real-time monitoring, and historical archives.
* Asynchronous Evaluation: Multi-threaded pipeline for concurrent benchmarking and qualitative scoring.
* Real-time Streaming: Server-Sent Events (SSE) provide live progress updates during model execution.
* VRAM Optimization: Automatic memory management using `keep_alive: 0` to enable sequential testing of large models on consumer hardware.
* Quality Gates: Integrated Ruff linting, security auditing (`pip-audit`), and automated unit testing.

## Quick Start

The fastest way to run the operator is using Docker and the provided `Makefile`.

### 1. Prerequisites

* [Docker](https://www.docker.com/get-started) and Docker Compose.
* [Ollama](https://ollama.com) service running.
* At least two models pulled in Ollama (one candidate, one judge).

### 2. Launching the Operator

```bash
# Initial one-time setup for external volumes
make setup

# Start the production environment
make prod
```
The application will be available at **http://localhost:5000**.

---

## Development

The project uses a modular `docker-compose` architecture and a unified `Makefile` for developer workflow.

### Standard Commands

| Command | Description |
|:--- |:--- |
| `make dev` | Start development environment with hot-reloading. |
| `make dev GPU=1` | Start development environment with NVIDIA GPU support. |
| `make ci` | Run full local pipeline: Auto-format, Lint, Security Audit, and Tests. |
| `make test` | Execute pytest suite with coverage report. |
| `make logs` | View real-time logs from the active environment. |
| `make down` | Stop the active environment. |
| `make clean` | Deep clean containers, network, and Python caches. |

### Manual Setup (Optional)

If you prefer to run the application without Docker:

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Configure Environment:
   Create a `.env` file based on `.env.example`.
3. Run:
   ```bash
   python app.py
   ```

## Architecture

* Backend: Flask (Python 3.14-slim), Gunicorn.
* Orchestration: Docker Compose (Modular Base + Overrides).
* CI/CD Infrastructure: Ruff (Linting/Formatting), Pytest (Testing), pip-audit (Security).
* Memory Management: Sequential VRAM unloading for low-latency testing environments.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
