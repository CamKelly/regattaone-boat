# RegattaOne Boat Backend

Firebase backend for RegattaOne boat devices. This directory lives inside the **[regattaone-boat](../)** monorepo alongside ESP-IDF firmware (`main/`) and the BLE web tool (`web/`).

Monorepo layout:

- **`client/`** — Angular PWA with Ant Design (ng-zorro), Firebase Auth, Firestore, and Cloud Functions
- **`functions/`** — Firebase Cloud Functions (Notehub lifecycle, presence sync, device CRUD)
- **`shared/`** — TypeScript data models shared by the client and functions (`@regattaone/shared`)
- **`docs/`** — Notehub route and presence sync setup

All commands below assume your shell is in **`backend/`** (this directory).

## Device model

A **device** is either an **anchor** or a **tag**:

| Kind | Description |
|------|-------------|
| `anchor` | Fixed or semi-fixed reference point |
| `tag` | Mobile tracking unit |

Anchor subtypes (`anchorType`):

| Type | Description |
|------|-------------|
| `port` | Port-side mark |
| `starboard` | Starboard-side mark |
| `fixed_dgps_mark` | Fixed differential GPS mark with exact latitude/longitude |
| `waypoint` | Race course waypoint |
| `boat` | A boat acting as an anchor device |

Shared types live in `@regattaone/shared` and are imported by both the PWA and Cloud Functions.

## Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project with **Authentication (Email/Password)**, **Firestore**, **Hosting**, and **Functions** enabled

## Setup

1. Install dependencies:

   ```bash
   npm install
   npm run build -w @regattaone/shared
   ```

2. Link your Firebase project:

   ```bash
   firebase login
   firebase use --add
   ```

   Update `.firebaserc` with your project ID.

3. Configure the Angular client with your Firebase web app config in `client/src/environments/environment.ts`.

4. Enable **Email/Password** sign-in in the Firebase Console under Authentication → Sign-in method.

## Development

Start the Angular dev server:

```bash
npm run serve:client
```

Run Firebase emulators (Auth, Firestore, Functions, Hosting):

```bash
firebase emulators:start
```

For local emulator use, `client/src/environments/environment.development.ts` sets `useEmulators = true`.

## Build & deploy

```bash
npm run build
firebase deploy
```

### First-time Cloud Functions deploy

Firebase Functions (2nd gen) need a one-time IAM setup in Google Cloud. As project **Owner**, open [IAM](https://console.cloud.google.com/iam-admin/iam) and grant:

| Principal | Role |
|-----------|------|
| `973138977769-compute@developer.gserviceaccount.com` | **Cloud Run Invoker**, **Eventarc Event Receiver** |
| `service-973138977769@gcp-sa-pubsub.iam.gserviceaccount.com` | **Service Account Token Creator** |
| `service-973138977769@gcp-sa-eventarc.iam.gserviceaccount.com` | **Eventarc Service Agent** |

If Eventarc was just enabled, wait 2–5 minutes for permissions to propagate, then redeploy:

```bash
firebase deploy --only functions
```

The deploy script vendors `@regattaone/shared` into `functions/vendor/` automatically so Cloud Run can load the shared model at runtime.

## Cloud Functions

| Function | Type | Purpose |
|----------|------|---------|
| `health` | HTTP | Health check endpoint |
| `notehubDeviceLifecycle` | HTTP | Notehub webhook — upserts hardware devices in Firestore (`boat.qo`) |
| `notehubPresenceAck` | HTTP | Notehub webhook — presence delivery acks (`presence_ack.qo`) |
| `syncDevicePresence` | Firestore trigger | Sends `presence.qi` deltas to peer devices |
| `processPresenceMessageRetries` | Scheduled | Retries pending presence deliveries |
| `createDevice` | Callable | Validates and creates an anchor/tag device (optional, for future UI) |

See [docs/notehub-setup.md](docs/notehub-setup.md) and [docs/device-presence-sync.md](docs/device-presence-sync.md) for Notehub route configuration.

## Auth flow

- `/login` — Email/password sign-in and account creation
- `/` — Protected home page with device list
