# Repository Guidelines

## Project Structure & Module Organization

Learning Lane is a Node/Express app with a dependency-free responsive frontend.

- `server.js` starts Express, sessions, Google OAuth, API routes, and static file serving.
- `src/db.js` owns SQLite connection setup, schema creation, and auth-related helpers.
- `src/routes.js` contains authenticated JSON API routes and dashboard aggregation logic.
- `public/index.html`, `public/app.js`, and `public/styles.css` define the mobile-friendly app UI.
- `.env.example` documents required runtime configuration.

## Build, Test, and Development Commands

- `npm install`: install Express, SQLite, Passport, and session dependencies.
- `cp .env.example .env`: create local configuration.
- `npm run dev`: start the app at `http://localhost:3000`.
- `npm start`: start with `NODE_ENV=production`.

Google OAuth credentials are required for normal login. SQLite data defaults to `./data/learning-lane.sqlite`.

## Coding Style & Naming Conventions

Use CommonJS on the server and plain HTML/CSS/JavaScript on the client. Keep two-space indentation, semicolons, double quotes, and lower camelCase names. Prefer small route helpers over inline repeated SQL. Keep parent-only authorization checks explicit before any mutation.

CSS should stay mobile-first, use `:root` variables for shared colors, and keep cards at `8px` radius to match the current UI.

## Testing Guidelines

There is no automated test suite yet. Before changes, manually verify Google login, onboarding, parent invite allowlisting, kid read-only access, manual session logging, timer save, dashboard updates, localStorage import, and mobile layout around 375px width.

If automated tests are added, prioritize API permission tests, SQLite migration tests, and pure dashboard calculations.

## Commit & Pull Request Guidelines

No project commit convention exists yet. Use concise imperative commits such as `Add kid dashboard permissions` or `Fix weekly goal aggregation`.

Pull requests should include a summary, manual test notes, screenshots for UI changes, and any database schema or environment-variable changes.

## Security & Configuration Tips

Do not commit `.env`, SQLite database files, session stores, or exported family data. Kid accounts are view-only by design; keep mutation endpoints parent-only.
