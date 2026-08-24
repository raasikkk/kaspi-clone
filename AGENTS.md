# Project Guidelines

## Build & Configuration

- **Node.js ≥ 20.6** required (ES modules via `"type": "module"`).
- Create `.env` with `TOKEN_SECRET_KEY` (64-char hex, 32 bytes) before first run — see `.env.example`.
- On first `npm start`, `keypair.json` and `device.json` are auto-generated (gitignored).
- Regenerate via `npm run regen:keypair` / `npm run regen:device` (invalidates sessions).

## Architecture

- **Entry point**: `server.js` — Express, routes under `/api/*`, static `public/`.
- **Source**: `src/config.js`, `src/crypto.js`, `src/helpers.js`, `src/session.js`.
- **Routes**: `src/routes/{auth,invoice,qr,history,refund}.js`.
- **Stateless after auth** — temp in-memory `Map` only during 3-step SMS flow; after that, session data lives on the client side (encrypted headers).

## Code Style

- **ES Modules** (`import`/`export`), semicolons, `const`, arrow functions.
- `async/await` with try/catch, JSON `{ error }` on failure.
- ESLint configured (`eslint.config.js`).
