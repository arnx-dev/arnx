// The review.yaml used by the Python test_config.py.
export const GOOD = `
version: 1
image: python:3.12-slim
workdir: app
install:
  - pip install -r requirements.txt pytest
test_command: python -m pytest -q {targets}
services:
  postgres:
    image: postgres:16-alpine
    env: {POSTGRES_HOST_AUTH_METHOD: trust}
    ready: pg_isready -U postgres
env:
  DATABASE_URL: postgresql://postgres@postgres:5432/postgres
notes:
  - set DATABASE_URL before importing db
known_failing: [tests/test_network.py]
`;

// The review.yaml used by the Python test_sandbox.py.
export const CFG = `
version: 1
image: python:3.12-slim
workdir: app
install: [pip install pytest]
test_command: python -m pytest -q {targets}
env: {MODE: test}
`;

// The review.yaml used by the Python test_testround.py.
export const ROUND_CFG = `
version: 1
image: python:3.12-slim
workdir: app
test_command: python -m pytest -q {targets}
services:
  db: {image: postgres:16-alpine, ready: pg_isready}
notes: [set DATABASE_URL before importing db]
`;

// A review.yaml with projects: two services that use a shared directory.
export const PROJECTS = `
version: 1
services:
  db: {image: postgres:16, env: {POSTGRES_HOST_AUTH_METHOD: trust}, ready: pg_isready -U postgres}
  mq: {image: rabbitmq:3}
projects:
  pay:
    root: services/pay
    language: python
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
    services: [db]
    env: {DATABASE_URL: postgresql://postgres@db:5432/postgres}
    uses: [services/shared/]
  feed:
    root: services/feed
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
    services: [db, mq]
    uses: [services/shared/]
uncovered:
  - {path: infra/, reason: Terraform; no adapter}
`;
