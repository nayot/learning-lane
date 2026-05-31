# Learning Lane

Learning Lane is a cute, game-style tutoring tracker for families. Parents sign in with Google, set learning goals, add kids and subjects, then record tutoring sessions. Kids get a cheerful read-only dashboard with energy, streaks, subject stamina, subject skill, rewards, and a long-term prize.

The app is designed for a mobile-friendly pink kawaii theme with original cartoon character artwork.

## Features

- Google authentication with parent and kid roles.
- Site-owner approval before a new family is created.
- Parent-created family setup with multi-kid support.
- Optional second parent access by Google email allowlist.
- SQLite database for users, families, kids, subjects, goals, prizes, and sessions.
- Manual session logging and live timer session logging.
- Daily **Energy** and **Today’s Quest Lane** based on today’s minutes vs target.
- **Weekly** progress meter based on weekly tutoring minutes.
- **Streak Sparkle** for consecutive tutoring days.
- **Subject Stamina** for time spent per subject.
- **Subject Skill** for average score per subject.
- Cute dashboard cards, character decorations, rewards, and prize tracking.
- One-time import of old Sweet Math Quest browser data.

## Tech Stack

- Node.js + Express
- SQLite via Node’s built-in `node:sqlite`
- Passport Google OAuth
- Gmail API for family approval emails
- Vanilla HTML, CSS, and JavaScript frontend

## Setup

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Environment

Configure `.env`:

```env
PORT=3000
DATABASE_PATH=./data/learning-lane.sqlite
SESSION_SECRET=replace-with-a-long-random-secret
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
APP_BASE_URL=http://localhost:3000
FAMILY_APPROVAL_REQUIRED=true
FAMILY_APPROVAL_EMAIL=nayot@eng.buu.ac.th
FAMILY_APPROVAL_TTL_HOURS=72
GMAIL_SENDER_EMAIL=nayot@eng.buu.ac.th
GMAIL_REFRESH_TOKEN=replace-with-gmail-refresh-token
```

Create a Google OAuth web client and add the callback URL above as an authorized redirect URI.

## Family Approval

New family onboarding does not create a family immediately. Instead, Learning Lane:

1. Stores a pending family request with a hashed one-time approval token.
2. Sends an approval link to `FAMILY_APPROVAL_EMAIL` using the Gmail API.
3. Requires the approver to sign in with that same Google email.
4. Creates the family only after the approval link is opened by the approver.

The approval link expires after `FAMILY_APPROVAL_TTL_HOURS`.

To send approval emails, the Gmail account in `GMAIL_SENDER_EMAIL` must grant a refresh token with Gmail send access. Keep `GMAIL_REFRESH_TOKEN` secret and never commit it.

## Development

```sh
npm run dev
```

The server serves the frontend from `public/` and APIs from `/api`.

Useful files:

- `server.js` starts Express, sessions, static serving, and Google OAuth.
- `src/db.js` creates the SQLite schema and database helpers.
- `src/routes.js` contains authenticated API routes and dashboard calculations.
- `public/` contains the mobile-friendly frontend and cartoon assets.

## Data

SQLite data is stored at `DATABASE_PATH`. To start fresh locally, stop the server and delete:

```sh
rm -f data/learning-lane.sqlite
```

Do not commit `.env`, `data/`, SQLite files, or exported family data.

## Dashboard Concepts

- **Energy**: today’s logged tutoring minutes divided by today’s weekday/weekend target.
- **Quest Lane**: visual red/yellow/green progress for today’s Energy.
- **Stamina**: total practice time per subject.
- **Skill**: average score per subject when scores are entered.
- **Streak**: consecutive days with at least one tutoring session.
