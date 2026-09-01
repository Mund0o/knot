# Knot deployment envelope

This repository is intentionally sized for one private community of roughly 20
people. A normal deployment uses Cloudflare Free only for the control plane and
does not require R2, Realtime SFU, a hosted database, or any new service account.

## Checked-in deployment

| Component | Normal route | Cloudflare Free deployment |
| --- | --- | --- |
| Accounts, friends, servers, group DMs, presence | SQLite-backed Durable Objects | Enabled |
| Encrypted offline envelopes and signaling | Hibernating Durable Object WebSockets | Enabled |
| Directory V2 and image references | Sharded public records; small referenced images fall back to the directory Durable Object | Enabled |
| Chat history and diagnostics | Encrypted local SQLite; allowlisted local metrics | Never uploaded |
| Voice, video, and screen sharing | Direct WebRTC mesh | No media sent through the Worker |
| Files | Authenticated direct TCP, then direct WebRTC | No file bytes sent through the Worker |
| Group-call SFU pilot | Explicit feature flag, audio only, P2P fallback | Disabled |
| Encrypted object relay | Explicit feature flag, direct presigned requests | Disabled; no R2 binding |

`wrangler.jsonc` binds only `PairRoom`, `PairDirectory`, and
`PairDirectoryShardV2`. It explicitly sets both optional hosted-feature flags to
`false`. A dry-run must continue to show no R2 binding and no SFU configuration.

## Why the control plane fits about 20 people

As of September 1, 2026, Cloudflare documents these relevant Free limits:

- Workers: 100,000 requests per day and 10 ms CPU per invocation.
- SQLite Durable Objects: 100,000 billed requests and 13,000 GB-s per day,
  5 million rows read and 100,000 rows written per day, and 5 GB total storage.
- A Worker WebSocket costs the initial upgrade request. For Durable Object
  compute billing, incoming WebSocket messages use a 20:1 conversion; outgoing
  messages are not billed as requests.

Twenty continuously connected clients are small relative to those ceilings. A
deliberately pessimistic example—20 clients sending one application heartbeat
every four seconds for 24 hours—is 432,000 incoming messages, or about 21,600
Durable Object request equivalents before normal directory traffic. Real usage
is lower because media flows P2P and inactive sockets hibernate. This is a
capacity estimate, not an SLA: on Free, operations fail after a daily limit is
exceeded, so check Cloudflare usage if the community or heartbeat rate grows.

Official references:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Features deliberately not put on the Free deployment

### Managed SFU

The client and Worker include a bounded, audio-only SFU compatibility pilot.
It publishes one Opus track, subscribes to at most 19 remote tracks, and falls
back to the direct mesh on setup failure. The checked-in deployment does not
configure it. Cloudflare currently advertises 1,000 GB/month of combined
Realtime SFU/TURN egress for free, but that is a quota rather than an unlimited
guarantee; a full 20-person call fans out substantially more traffic than P2P
signaling. Keep it off unless usage has been measured and the operator accepts
the quota. A loopback HTTP API base is accepted for local development, and an
HTTPS API-compatible self-hosted gateway can be used without changing clients.

- [Realtime SFU pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- [Realtime limits](https://developers.cloudflare.com/realtime/sfu/limits/)

### Encrypted object relay

The last-resort relay remains off because normal direct files need no storage
quota and R2's free storage is finite (currently 10 GB-month, 1 million Class A
operations, and 10 million Class B operations per month). The implementation is
still usable with a local S3-compatible store such as MinIO; no vendor signup is
required. The store must be reachable directly by both clients and must enforce
automatic deletion for the `knot-file-relay/v1/` prefix before the operator sets:

```text
ENCRYPTED_FILE_RELAY_ENABLED=true
FILE_RELAY_LIFECYCLE_CONFIRMED=true
FILE_RELAY_ACCESS_KEY_ID=...
FILE_RELAY_SECRET_ACCESS_KEY=...
FILE_RELAY_BUCKET=...
FILE_RELAY_REGION=...
FILE_RELAY_S3_ENDPOINT=https://your-s3-compatible-endpoint
```

The credentials should be restricted to that bucket/prefix. The Worker signs
metadata only; clients upload/download ciphertext directly. PUT signatures bind
the exact AES-GCM ciphertext length and `application/octet-stream`, URLs expire
after 15 minutes, records expire after 24 hours, unannounced cancellations use
an authenticated direct DELETE, and lifecycle expiry remains the final cleanup.

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

## Local-only storage

The desktop app uses Node's built-in SQLite module. There is nothing to install
or sign up for. Knot creates its encrypted history database and privacy-safe
metrics database under the existing per-user Knot data directory. Emoji.gg
metadata and viewed images are fetched on demand into bounded local caches;
Unicode emoji remain as the offline seed, and no Emoji.gg originals ship in the
installer.

## Revisit thresholds

Re-evaluate the design before increasing the private community above 20, before
turning on a managed media path, or if Durable Object request usage regularly
exceeds about 70,000/day. Prefer reducing heartbeat/fan-out and retaining P2P
media before adding a paid dependency.
