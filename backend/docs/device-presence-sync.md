# Device presence synchronization

Event-driven LoRa presence sync for Notehub devices. When a device document in `devices/{deviceId}` changes, Cloud Functions send compact delta notifications to peer devices via Notehub inbound notes.

## Firestore device fields

Presence sync reads these fields on Notehub device documents:

| Field | Description |
|-------|-------------|
| `deviceId` | Logical device ID (falls back to `boatId`) |
| `notehubDeviceUid` | Notehub UID (`dev:…`, also used as doc ID) |
| `online` | `true` when the device is connected |
| `lastSeen` | Last activity timestamp |
| `deviceType` | Device role/type |
| `raceId` | Optional race scope for future filtering |
| `fleet` / `fleetId` | Optional fleet scope |
| `product` | Notehub product UID used for outbound API calls |

## Events

| Transition | Peer notification | Newly-online device |
|------------|-------------------|---------------------|
| `online: false → true` | `DEVICE_ONLINE` | `ONLINE_DEVICE_SNAPSHOT` |
| `online: true → false` | `DEVICE_OFFLINE` | — |
| `deviceId` changed | `DEVICE_ID_CHANGED` | — |
| document deleted | `DEVICE_REMOVED` | — |

Compact inbound payload example:

```json
{ "t": "on", "mid": "a1b2c3d4", "ts": 1716500000000, "id": "boat_12", "dt": "boat" }
```

## Notehub notefiles

| Direction | Notefile | Purpose |
|-----------|----------|---------|
| Cloud → device | `presence.qi` | Inbound presence deltas |
| Device → cloud | `presence_ack.qo` | Delivery acknowledgement |

Device firmware should:

1. Read notes from `presence.qi`
2. Apply compact delta to local peer map
3. Publish `{ "mid": "<messageId>", "ok": true }` to `presence_ack.qo`

Route `presence_ack.qo` to the `notehubPresenceAck` HTTP function (same Bearer token as lifecycle webhook).

## Cloud Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `syncDevicePresence` | Firestore `devices/{deviceId}` write | Detect transitions and enqueue/send deltas |
| `notehubPresenceAck` | HTTP POST | Mark outbound messages as acknowledged |
| `processPresenceMessageRetries` | Every 5 minutes | Retry pending/sent messages |

## Secrets / params

| Name | Type | Purpose |
|------|------|---------|
| `NOTEHUB_PAT` | Secret | Notehub personal access token for outbound API calls |
| `NOTEHUB_WEBHOOK_TOKEN` | Secret | Bearer token for inbound Notehub webhooks |
| `NOTEHUB_PROJECT_UID` | Param (optional) | Fallback project UID when device docs omit `product` |

## Outbound queue

Pending deliveries are tracked at:

`deviceOutboundQueue/{notehubDeviceUid}/messages/{messageId}`

Statuses: `pending` → `sent` → `acked` (or `failed` after max retries).

## Deploy

```bash
firebase functions:secrets:set NOTEHUB_PAT
firebase deploy --only functions:syncDevicePresence,functions:notehubPresenceAck,functions:processPresenceMessageRetries,firestore:rules,firestore:indexes
```

## Race-aware filtering

`shouldNotifyPeer()` in `@regattaone/shared` skips peers when `raceId` or `fleetId` do not match. Extend this hook when race-scoped sync is required.
