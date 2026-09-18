# DeputyDev Console (frontend)

Management console UI for DeputyDev. Part of the [DeputyDev monorepo](../../README.md).

This app is managed with **pnpm**, not Bun, and is deliberately outside the root Bun workspace. Run every command from this directory.

## Stack

Vite, React 19, TypeScript, Tailwind CSS v4, shadcn (radix base, `mira` style), ESLint, and Prettier.

## Setup

```bash
cd apps/frontend
cp config_template.json config.json
pnpm install
pnpm dev
```

`config.json` is per-environment and git-ignored. `config_template.json` is the checked-in shape; update both together when adding a key. Vite reads it for the dev/preview port, the base path, and the API origin, and it is importable in app code as `@config`.

## Scripts

| Script             | What it does                       |
| ------------------ | ---------------------------------- |
| `pnpm dev`         | Vite dev server on `config.port`   |
| `pnpm build`       | Typecheck the project, then build  |
| `pnpm preview`     | Serve the production build         |
| `pnpm typecheck`   | TypeScript only                    |
| `pnpm lint`        | ESLint                             |
| `pnpm format`      | Prettier write                     |

## Conventions

`@/*` resolves to `src/*`. Add shadcn components with `pnpm exec shadcn add <name>`; they land in `src/components/ui` and are excluded from Prettier so they stay close to upstream.
