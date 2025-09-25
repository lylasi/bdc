# Repository Guidelines

## Project Structure & Module Organization
This static web app is anchored by `index.html`, `styles.css`, and `main.js`, which together render the frame, apply the global theme, and bootstrap features. Shared services belong in `modules/`—reuse the existing state, DOM, storage, UI, audio, API, and platform helpers before adding new utilities. Feature logic lives under `features/<name>/` and should export an `init*` entry point plus any supporting tools; split files that approach 300 lines into nearby helpers. Store written content in `articles/`, vocabulary in `wordlists/`, curated prompts in `qa-sets/`, and reference `docs/prd.md` and `PLAN.md` when adjusting QA flows.

## Build, Test, and Development Commands
- `npx serve .` — launch a local static server aligned with ES module imports.
- `npx http-server -c-1 .` — serve with caching disabled for storage-debug sessions.
Run these from the repository root to mirror production URL paths.

## Coding Style & Naming Conventions
Target ES2022 syntax with four-space indentation and single quotes. Prefer `const` and `let`; use `camelCase` for functions and variables, reserving `PascalCase` for classes or namespaces. Route DOM interactions through the selectors in `modules/dom.js` instead of direct `document.querySelector` calls. Keep inline comments focused on rationale or TODOs, tagged with owner initials when needed.

## Testing Guidelines
There is no automated test runner. Open `test-floating-statusbar.html` in a browser to cover platform detection, persistence, and floating controls after each significant change. When expanding QA features, update the relevant `qa-sets/*.json` fixture and note the dataset in review notes so scenarios are reproducible.

## Commit & Pull Request Guidelines
Follow Conventional Commit prefixes such as `feat:`, `fix:`, or `chore:` with concise summaries in either Chinese or English. Keep branches focused on a single change set, link PRs to supporting docs or tickets, and include before/after captures when UI shifts. Document manual verification steps, configuration tweaks, and any data migrations directly in the PR description to streamline review.

## Security & Configuration Tips
Before deploying, copy `ai-config.example.js` to a private `ai-config.js` and exclude secrets from version control. If you introduce external API calls, document rate limits and fallback handling inside `modules/api.js` to protect the UI thread. Review `wordlists/` and `articles/` for sensitive content before sharing artifacts.


#使用繁體中文
