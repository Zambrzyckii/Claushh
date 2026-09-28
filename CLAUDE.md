# Working rules for the Claushh repository

Read [`docs/PLAN.md`](docs/PLAN.md) (goal and decisions) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first
(current code map).

## Documentation is part of every change

In this repository documentation has priority. It should let you find your way around the code quickly.

- Every code change that adds, removes or moves a module, endpoint, route, dependency, configuration
  variable or command updates `docs/ARCHITECTURE.md` in the same step.
- A change of a decision, the stack or a stage's scope updates `docs/PLAN.md`. Tick off a completed stage in the "Stages" section.
- A change in how the app is run updates `README.md`.
- A new file or class with a non-obvious role gets a short comment at the top: why it exists and where it is described.
- Documentation, comments and code identifiers in English.

## Commits

- **Do not make commits on your own.** After finishing a change, propose a commit name
  and wait for approval. The name in English, a short sentence in the imperative mood,
  **without prefixes** such as `feat:`, `docs:`, `fix(api):` (e.g. `add TOTP login`).
- Commit only after explicit permission, with exactly the approved message.

## Tests

- **Do not write new unit tests.** Test new code with integration and e2e tests.
- Integration (Vitest, `web/src/**/*.spec.ts`): real components and services together, with only the
  network boundary replaced (HTTP through `HttpTestingController`, SignalR by replacing the connection).
- E2E (Playwright, `web/e2e/`): the built app in a browser with the mock backend `web/e2e/mock-api/`,
  which implements the contracts from `docs/ARCHITECTURE.md`. A contract change requires a mock change.
- Existing unit tests stay until the owner decides otherwise.

## Security

The portal gives access to files, the terminal and GitHub, so the rules from the "Security" section in `docs/PLAN.md`
are mandatory. In particular: every endpoint and hub except `/api/health` and login requires authorization,
every file path is checked against the projects directory, secrets never go into the repo.

## Commands

```bash
dotnet build Claushh.slnx               # backend
dotnet run --project src/Claushh.Api    # API at http://localhost:5080
cd web && npm test                      # frontend integration tests (Vitest)
cd web && npm run e2e                   # build + e2e tests (Playwright) on the mock API
cd web && npm run build                 # frontend build
```
