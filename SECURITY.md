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
output as text, never as HTML. CSV exports prefix cells that start with `=`,
`+`, `-`, `@`, a tab or a carriage return with an apostrophe, so a spreadsheet
does not run them as formulas. Markdown exports fence model answers with a
fence longer than any backtick run inside them and quote the judge text.

## Supply chain

- Images and Actions are pinned by digest or SHA; dependencies are locked
  with hashes.
- CI runs Trivy on the published image, `pip-audit` on dependencies and
  zizmor on workflows, with the results uploaded to code scanning; daily
  scheduled scans cover the published image.
- CodeQL analysis runs on pushes and pull requests (default setup), in
  addition to the SARIF scanners.
- Release images are attested with build provenance; attestations live in
  the GitHub Attestations API only (no referrer manifests in GHCR). Anyone
  can verify a published image:
  `gh attestation verify oci://ghcr.io/ykvit/lmao:latest --repo ykvit/lmao`
- Releases are immutable: once published, their assets and tags cannot be
  modified or deleted.
- Dependabot alerts, security updates and grouped version updates are
  enabled: weekly for the runtime group, monthly for CI tooling.
- Secret scanning and push protection are enabled.
- `main` and `v*` tags are protected by rulesets: pull requests with
  required CI checks, squash-only merges with linear history, no direct
  pushes, no force pushes and no tag deletion.