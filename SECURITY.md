# Security

MindGate holds API keys of cloud providers (encrypted at rest with AES-256-GCM) and hands out keys to clients, so reports about it are welcome.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include the version or commit, what you did, and what happened. You will get an answer within a few days.

## What is supported

Only the latest commit on `main`. There are no maintained release branches.

## What the project does about it

- Provider keys are encrypted with `MINDGATE_MASTER_KEY`; client keys are stored as hashes; the hub refuses to start with placeholder secrets.
- `/admin` is behind a separate token, with login throttling; the hub answers with a strict Content-Security-Policy.
- The container runs as an unprivileged user with a read-only root filesystem and no extra capabilities (see `gate/docker-compose.yml`).
- CI runs the tests, `npm audit` on production dependencies, CodeQL, and a secret scan on every push; Dependabot proposes updates weekly.

The design, including the threat model of each component, is described in [docs/](docs/).
