# Notehub → Firebase setup

The `notehubDeviceLifecycle` function upserts one document per Notecard in **`devices/{notehubDeviceUid}`**. No separate event log.

## Notehub payload

```json
{
  "event": "8297eae6-ac49-4c4c-9668-7df7d21c4f72",
  "file": "boat.qo",
  "body": { "id": "kitchen", "deviceType": "boat", "reason": "boot" },
  "transport": "lorawan:ttn",
  "device": "dev:0080e115004531d2",
  "product": "product:com.ellph.camkelly:regattaone",
  "received": 1779576997.671118,
  "fleets": ["fleet:c5e4f920-6dc8-4844-b672-313babdbc685"]
}
```

## Firestore document

**Path:** `devices/dev:0080e115004531d2`

**First webhook (create):** full record including `boatId`, `deviceId`, `deviceType`, `online: true`, `lastSeen`, `reason`, `transport`, `product`, `fleet`, `lastEventTime` from `received`, `createdAt`, `lastUpdatedAt`, and `source: "notehub"`.

**Subsequent webhooks (update):** `reason`, `boatId`, `deviceId`, `deviceType` (when present in the body), `online: true`, `lastSeen`, `lastEventTime`, `lastEventId`, and `lastUpdatedAt`.

Every accepted `boat.qo` note marks the device **online** and refreshes **lastSeen**, which triggers presence sync when `online` transitions from false/absent to true.

## Deploy

```bash
firebase deploy --only functions:notehubDeviceLifecycle,firestore:rules
```
