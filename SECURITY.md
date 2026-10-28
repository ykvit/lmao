# Security Policy

## Supported versions

Only the latest release (`ghcr.io/ykvit/lmao:latest`) receives fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: **Security** tab,
then **Report a vulnerability**. Include the version, steps to reproduce and the
impact. Reports are handled on a best-effort basis.

## Security model

lmao is a local tool for one trusted user. It has no authentication: anyone who
can reach its port can run evaluations, read the history and use your Ollama
models.

- Compose binds the app to `127.0.0.1` only (`make check` enforces it). Do not
  expose the app or Ollama (`11434`) to a network without a reverse proxy or VPN
  that adds authentication.
- The production image runs as a non-root user.

## Data handling

- **Local mode (default):** prompts and answers go only to your own Ollama.
- **Cloud judge (off by default):** questions, criteria, reference answers and
  all candidate answers are sent to Ollama's cloud service. Do not use it with
  confidential data.
- **History:** every run is saved as JSON in `history/` (a Docker volume in
  prod) with your questions and the model answers. `make reset` removes the
  prod volume.

## Untrusted model output

Candidate answers are wrapped in delimiters and given to the judge as data, and
the grade must match a fixed JSON schema. This reduces but does not eliminate
prompt injection, so scores are not a security boundary. The UI renders model
output as text, never as HTML.

## Supply chain

Images and Actions are pinned by digest or SHA, and dependencies are locked with
hashes. CI runs Trivy, `pip-audit` and zizmor, daily scans cover the published
image, and release images are attested.