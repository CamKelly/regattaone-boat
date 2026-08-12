# UWB Start-Line Ranging Protocol

## Purpose

This protocol positions one or more boats relative to the start line between a Port mark and a Starboard mark. It uses scheduled double-sided two-way ranging (DS-TWR). It does not use TDoA, synchronized anchor transmissions, or a Reference mark.

Meshtastic, IMU, and GPS operation are independent of this protocol and remain unchanged.

## Devices and addresses

- Port is the network coordinator and always uses UWB short address `0x0001`.
- Starboard always uses UWB short address `0x0002`.
- An unregistered Boat uses `0x0000`.
- Port dynamically assigns registered Boats addresses from `0x0100` through `0xFFFE`.
- `0xFFFF` is broadcast.

Each Boat has a persistent 128-bit UUID derived from its ESP32 hardware identity. A short Boat address and all registration state are volatile and are discarded at reboot or communication loss.

The current firmware table holds up to 16 concurrently registered Boats. Additional requests are rejected until an entry expires or is removed.

## Default configuration

| Setting | Default |
|---|---:|
| Boat registration retry | 5,000 ms, with random ±500 ms jitter |
| Boat grant duration | 20 ms |
| Boat inactivity minimum | 5,000 ms |
| Maximum missed grants | 3 |
| P↔S baseline refresh | Before every complete queue rotation |
| Maximum baseline age | 5,000 ms |
| Baseline retries | 2 |
| Boat retries per mark per grant | 1 |

The effective inactivity timeout is:

```text
max(configured inactivity timeout, 3 × estimated queue rotation time)
```

## Registration

An unregistered Boat broadcasts `REGISTER_REQUEST` at its configured retry interval plus jitter. The request contains protocol version, sequence, UUID, optional GPS position and validity, capabilities, and a fresh registration nonce.

Port treats registration by UUID as idempotent. An existing UUID retains its current short address; a new UUID receives the next available address. Port replies with one short-address data frame sent to broadcast address `0xFFFF`. Its `REGISTER_RESPONSE` payload contains the target Boat UUID and nonce, assigned address, fixed mark addresses, latest P↔S baseline and age, registration lease, estimated rotation period, Port session ID, and configuration version. Every listening Boat may receive the frame, but only the Boat whose UUID and nonce match processes it.

A Boat accepts the response only when its UUID and current nonce match and the assigned address is valid. It then changes its runtime UWB address and enters the registered state. Registration state is not stored in NVS.

Port generates a new random session ID at every boot. A Boat discards its registration if it receives a response or grant for a different Port session, or if valid Port communication exceeds its effective timeout.

## Baseline ranging

Before every complete rotation through the registered-Boat queue, Port performs DS-TWR with Starboard. Port retries twice by default. A successful result becomes the current P↔S baseline.

Port does not issue Boat grants without a valid baseline newer than the configured maximum baseline age. The measured baseline is also carried in every grant and is the `PS` value displayed by a connected Boat.

## Grant scheduler

Port maintains a volatile circular queue of registered Boats. For each Boat, Port broadcasts one target-specific `RANGING_GRANT` containing:

- target Boat UUID
- target Boat address
- Port and Starboard addresses
- Port session ID and configuration version
- P↔S baseline and age
- grant duration
- estimated queue rotation
- grant sequence and random nonce

The grant is a short-address data frame sent to broadcast address `0xFFFF`, not an IEEE 802.15.4 multipurpose blink. All Boats may receive it, but Boats ignore grants whose target UUID does not match their own; the matching Boat also verifies its assigned short address before transmitting.

Starboard does not consume grants or coordinate Boat access. It is a passive TWR responder and answers any peer that initiates ranging. Port alone schedules Boats so Starboard never needs to manage overlapping requests.

The granted Boat performs, in this exact order:

1. Boat↔Starboard DS-TWR
2. Boat↔Port DS-TWR
3. Position calculation
4. Return to listening

Port advances immediately after it accepts the completed Boat↔Port Final exchange. If this does not happen before the advertised grant duration expires, Port skips the remainder of that slot and grants the next Boat. A Boat must stop initiating transmissions at the slot deadline. Each mark range permits at most one retry when sufficient slot time remains.

## Registration liveness and removal

Only successful completion of a Boat↔Port DS-TWR Final refreshes that Boat's `last_successful_range` at Port. Registration requests and other packets do not refresh this ranging-liveness timestamp.

Port completely removes a Boat and releases its short address when either:

- time since successful Boat↔Port ranging exceeds the effective inactivity timeout; or
- its consecutive missed grants reaches the configured maximum.

Released addresses may be reassigned after removal. A removed Boat eventually times out locally, returns to `0x0000`, and registers again.

## Position calculation

Let `L` be P↔S, `rP` be Boat↔Port, and `rS` be Boat↔Starboard, in the same units:

```text
x = (rP² - rS² + L²) / (2L)
y = sqrt(max(0, rP² - x²))
```

Port is `(0,0)`, Starboard is `(L,0)`, and Boat is `(x,+|y|)`. DS-TWR has a mirror ambiguity, so the Position UI retains its Flip Y control.

The triangle is valid, allowing a 0.30 m measurement margin, only when:

```text
rP + rS >= L
rP + L  >= rS
rS + L  >= rP
```

The Boat updates its plotted position only after both mark ranges succeed in the same grant and pass validation. If either range fails, the previous Boat point remains visible but is marked stale.

## User interface

The Position tab shows only P, S, and B. It labels P↔S in centimetres and inches and shows BP and BS after a successful cycle. It supports zoom, pan, reset, and Flip Y.

The Port UI shows baseline state, registered-Boat count, current grant, estimated rotation time, scheduler controls, timeout settings, and the volatile Boat table. The Boat UI shows UUID, registration state, assigned address, Port session, time since Port contact, BP/BS/PS, calculated position, freshness, and the last failure.

Detailed ranging diagnostics are configurable. Normal logging reports state transitions, registration, grants, final distances, positions, timeouts, and removals. When diagnostics are enabled, logs additionally include raw DS-TWR timestamps, intermediate intervals, ToF calculation data, clock-offset information, sequence numbers, antenna delay, and failure detail.

## Normal log events

```text
REGISTER request/accepted/response
GRANT sent/received/expired/completed
TWR starboard success/failure
TWR port success/failure
POSITION valid/stale with BP, BS, PS, x and y
REMOVE boat with timeout or missed-grant reason
STATE old → new with reason
```

## Safety and concurrency

Only one task or serialized operation may control the DW3000 at a time. Registration responses, baseline ranging, grants, and Boat ranging must not transmit concurrently. Packets with the wrong destination, Port session, target Boat, grant nonce, or active-slot timing are ignored. Forty-bit DW3000 timestamp wrapping must not affect DS-TWR calculations.
