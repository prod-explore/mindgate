# Security

MindGate holds API keys of cloud providers (encrypted at rest with AES-256-GCM) and hands out keys to clients, so reports about it are welcome.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include the version or commit, what you did, and what happened. You will get an answer within a few days.

## What is supported

Only the latest commit on `main`. There are no maintained release branches.

## Scope

In scope: the code in this repository — the hub (`gate/`, including its admin API, the panel it serves and the Wake-on-LAN relay), the node agent (`agent/`), the tray app (`tray/`), the admin panel (`panel/`) and the Docker setup in `gate/`. For example: a way past the client-key or admin-token checks, a request marked local-only reaching a cloud provider, a stored provider key coming back in a response or a log, a path out of the panel directory, or a way to make the agent shut a machine down or download a model without the node secret.

Out of scope: vulnerabilities in Ollama, the cloud providers or other third-party software (report those to their authors), a deployment that ignores the documented setup (the agent or `/admin` exposed to the internet without TLS or a firewall), and attacks that need the master key, the admin token or root on the host.

## What the project does about it

- Provider keys are encrypted with `MINDGATE_MASTER_KEY`; client keys are stored as hashes; the hub refuses to start with placeholder secrets.
- `/admin` is behind a separate token, with login throttling; the hub answers with a strict Content-Security-Policy.
- The container runs as an unprivileged user with a read-only root filesystem and no extra capabilities (see `gate/docker-compose.yml`).
- CI runs the tests, `npm audit` on production dependencies, CodeQL, and a secret scan on every push; Dependabot proposes updates weekly.

How each component is secured is described in [docs/](docs/): the hub in [01](docs/01-gate.md), the agent in [02](docs/02-agent.md#security), the panel in [09](docs/09-panel.md#security).
