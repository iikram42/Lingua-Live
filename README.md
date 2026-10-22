# Lingua Live

A two-person voice and video call application with private room links, WebRTC media, and optional live speech translation.

## Architecture

- React, TypeScript, and Vite provide the responsive browser client.
- Express provides room APIs and a WebSocket channel for WebRTC signaling, captions, and translated audio.
- SQLite stores room metadata, hashed invitation/session secrets, and room lifecycle state.
- Original voice/video travels over peer-to-peer WebRTC. Translated speech travels as a separate WebSocket audio message and is played by the receiving browser. The translated output is never added to the microphone or WebRTC source stream.
- Google Cloud Speech-to-Text streaming, Cloud Translation, and Cloud Text-to-Speech are server-side adapters. Hindi (hi-IN), Indonesian (id-ID), and US English (en-US) are enabled initially.

## Local setup

Requirements: Node.js 22 or newer and npm.

~~~powershell
Copy-Item .env.example .env
npm ci
npm run dev
~~~

Open the Vite address printed in the terminal. The API runs on port 3001 and Vite forwards API and WebSocket requests to it.

Without Google Cloud credentials, room creation, signaling, and WebRTC calls remain available; translated captions and speech show as unavailable. The application does not return simulated translations.

## Google Cloud configuration

1. Create or select a Google Cloud project and enable Speech-to-Text, Cloud Translation, and Text-to-Speech APIs.
2. Set GOOGLE_CLOUD_PROJECT in .env.
3. Configure Application Default Credentials for the server process. For a local developer account, use gcloud auth application-default login. A service account can be supplied through GOOGLE_APPLICATION_CREDENTIALS; keep its file outside this repository.
4. Grant the server identity the permissions required to use the three APIs.
5. Restart the server and check /api/health for the provider configuration flag.

The selected speech recognizer uses the latest_long streaming model with 16 kHz LINEAR16 microphone frames. Transcripts, translations, and synthesized speech exist in memory only while the call is active; this app does not write them to SQLite or local logs. Google Cloud processes the audio and text, so provider retention and access depend on your Google Cloud settings and agreements.

## TURN and STUN

The app uses Google's public STUN endpoint for ICE discovery. Direct peer connections can fail on restrictive networks. Configure TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL together to add a TURN relay. The configured credentials are sent to authenticated room members as part of the ICE configuration. For a public deployment, issue short-lived TURN credentials from a protected service; do not expose permanent TURN credentials from environment variables.

WebRTC encrypts media transport but may reveal network information between peers. Audio sent to Google Cloud for speech processing is not end-to-end encrypted from that provider. A TURN relay does not change the provider processing boundary.

## Environment

| Variable | Purpose |
| --- | --- |
| PORT | API server port; defaults to 3001 |
| DATABASE_PATH | SQLite database path; defaults to .data/rooms.sqlite |
| PRODUCT_NAME | Server-side product name |
| VITE_PRODUCT_NAME | Product name displayed in the browser |
| GOOGLE_CLOUD_PROJECT | Enables provider calls when ADC is configured |
| GOOGLE_APPLICATION_CREDENTIALS | Optional ADC service account file path |
| TURN_URL, TURN_USERNAME, TURN_CREDENTIAL | Optional relay settings |
| APP_ORIGIN | Public HTTPS origin; required in production |

## Database

The server applies numbered SQL migrations transactionally at startup. Migration migrations/001_init.sql creates the minimal room table and indexes. The default database file is ignored by Git. Room records expire after 24 hours and are marked ended when the server cleanup runs.

## Commands

- npm ci installs the lockfile dependencies.
- npm run dev starts the API and Vite.
- npm run lint runs ESLint.
- npm run typecheck checks client and server TypeScript.
- npm test runs room lifecycle and invitation tests.
- npm run build creates dist/client and compiles the server into dist/server/server.
- npm start starts the compiled server and serves the built client.

## CI

The GitHub Actions workflow installs with npm ci, then runs lint, type checking, unit tests, and the production build on Node.js 22.

## Security and privacy

Invitation secrets are 256-bit random values, stored as SHA-256 hashes, and kept in the invitation URL fragment so they are not sent with the initial page request. Room/session checks, capacity enforcement, and revocation run on the server. Session cookies are HTTP-only, SameSite Strict, and scoped to a room API path. No accounts are required for this private two-person MVP.

Audio and video are not stored by this app. Transcripts and translated text are also not persisted. Google Cloud receives audio/text when translation is enabled. Review provider settings, agreements, and retention controls before using the service with sensitive conversations. Rate limits are process-local, so a multi-instance deployment needs shared rate limiting and coordinated room state.

## Known limitations

- Live Google provider calls require a configured project and valid ADC credentials; no credentials are included.
- TURN is optional and has not been provisioned by this project.
- The default database and in-memory rate limits are intended for a single server instance.
- Real translation quality, latency, two-browser media connectivity, and provider retention need validation in the deployment environment.
- The UI supports Hindi, Indonesian, and US English only. Other languages need confirmation of speech, translation, and voice support.
- Static TURN credentials must be replaced with short-lived credentials before public service.
