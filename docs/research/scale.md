# Scaling OpenMail to millions of messages a day

Research note, 2026-11-07. Target: one deployment that sends **1M to tens of millions of messages a day**, has many users, and handles **one message to 150 recipients without trouble**. Engine: Stalwart **v1.0.3** (the version pinned in `deploy/`).

**Short answer.** Stalwart Community (AGPL-3.0) can scale out on its own: stateless nodes behind a load balancer, PostgreSQL (or FoundationDB), S3 blob storage, Redis/Valkey, and a coordinator. No Enterprise license is needed for clustering. CPU and Stalwart's code are not what limit volume. These do, in this order:

1. **Sender reputation.** Do IPs and the domain get into Gmail, Outlook and Yahoo inboxes? This depends on warm-up, abuse control and the spam-complaint rate.
2. **The shared data store.** PostgreSQL is the first component to saturate. Stalwart's own benchmark shows this (below).
3. **Outbound concurrency.** This is delivery threads × remote latency. It's a single setting to tune.

A working 2-node reference cluster is in [`deploy/scale/`](../../deploy/scale/). A load tester is in [`deploy/scale/loadtest.mjs`](../../deploy/scale/loadtest.mjs).

---

## 0. How things were verified

Stalwart 1.0 replaced the 0.x TOML config with typed JMAP objects (`x:Domain`, `x:MtaInboundThrottle`, …). Most blog posts and forum answers still describe 0.x keys (`queue.outbound.throttle`, `[store."..."]`), so they don't apply. I verified 1.0 names in three ways:

- **Live server schema.** The v1.0.3 dev server serves its full config schema at `GET /api/schema` (gzip, about 1 MB: 161 object types, every field, and an `enterprise: true` flag on each Enterprise-only object or field). Every object and field name in this document and in `deploy/scale/` was checked against it, or against `x:<Object>/get` on the running server.
- **Current docs** at stalw.art/docs (pages stamped "Last updated: Nov 4, 2026", written for 1.0). Pages used: cluster overview/storage/sizing/roles/node-id/coordination/load-balancing, mta/outbound/{queue,rate-limit,connection,strategy,quota}, mta/inbound/{rcpt,rate-limit,data}, performance/{mail-throughput,cluster,data-store}, telemetry/metrics/{prometheus,opentelemetry}, mta/authentication/arc, server/enterprise.
- **Running it.** The 2-node cluster in `deploy/scale/` was brought up from empty and configured by `setup.mjs`. I sent mail through HAProxy, read the same mailbox from both nodes, and scraped Prometheus. The 150-recipient behaviour was tested on the dev server.

Anything else is marked **(unverified)**. Section 12 lists everything that couldn't be verified.

---

## 1. Storage backends

Stalwart has four stores plus a coordinator. Values below come from `GET /api/schema` on v1.0.3.

| Store (object) | Single node today | For a cluster (open source) | Notes |
|---|---|---|---|
| Data store (`x:DataStore`, the only one in each node's `config.json`) | `RocksDb` | **`PostgreSql`**, `MySql`, or **`FoundationDb`** | RocksDB and SQLite can't be shared. Changing the data store later needs a data migration, so **start the hosted instance on PostgreSQL even while it is one node**. FoundationDB needs Stalwart's separate FDB build. PostgreSQL/MySQL `readReplicas` are **Enterprise**. |
| Blob store (`x:BlobStore`): message bodies, attachments | `Default` (inside the data store) | **`S3`** (any S3-compatible), `Azure`, `PostgreSql`, `MySql`, `FoundationDb`, `FileSystem` (only on a shared file system) | `Sharded` is **Enterprise**. Stalwart writes each blob once, so redundancy has to come from the storage service (bucket replication, erasure coding). `verifyAfterWrite` (on by default) reads each object back after writing it. |
| Search store (`x:SearchStore`) | `Default` (data store) | `Default` on PG/FDB, or `ElasticSearch` / `Meilisearch` | At large scale, move search off PostgreSQL so indexing doesn't compete with mail writes. |
| In-memory store (`x:InMemoryStore`): rate-limit counters, locks, greylist, tokens | `Default` (in-process) | **`Redis`** (Valkey works), `RedisCluster`, `RedisSentinel` | Required in a cluster: the server refuses the local store once a coordinator is set. `Sharded` is **Enterprise**. Give Redis `maxmemory` and `volatile-lru`. |
| Coordinator (`x:Coordinator`): cache invalidation, IDLE/push fan-out, "wake up, new queue item" | `Disabled` | **`Default`** (reuse the in-memory Redis via pub/sub), `Redis*`, **`Nats`** | `Kafka` and `Zenoh` exist in the schema, but the docs say they're "available in custom builds" only. Without a coordinator, revoked tokens and role changes stay live on the other nodes, so a cluster must have one. |

**What to choose**

- **Up to about 10M messages a day:** PostgreSQL 16/17 (primary + streaming standby, Patroni or a managed service), S3 (managed, or self-hosted Garage/Ceph RGW/SeaweedFS), Valkey with Sentinel, and the coordinator set to `Default`.
- **Beyond that,** or once one PostgreSQL primary's write rate is the bottleneck: **FoundationDB**, which is open source, scales horizontally, and is the backend Stalwart recommends for large clusters. The alternative is Enterprise read replicas, but they only relieve reads, and mail ingest is write-heavy.
- **MinIO:** I tried to use it in the reference stack. Its Docker Hub and quay.io images couldn't be pulled (checked today: `minio/minio` tags are gone and quay returns 401). The reference stack therefore uses **SeaweedFS** (Apache-2.0). Garage and Ceph RGW also work.

## 2. Clustering: open source or Enterprise?

| Capability | Edition | Source |
|---|---|---|
| Multi-node cluster, shared stores, node-ID leases (max 512 nodes) | **Community (AGPL-3.0)** | docs/cluster/*; the Enterprise feature list doesn't include clustering |
| Coordinator: Redis/Valkey, Redis Cluster/Sentinel, NATS | **Community** | schema `x:Coordinator` variants, no enterprise flag |
| Cluster roles (`x:ClusterRole`, `STALWART_ROLE`), push sharding (`STALWART_PUSH_SHARD`) | **Community** | schema; docs/cluster/configuration/roles |
| PostgreSQL / MySQL / FoundationDB / S3 / Azure / Redis stores | **Community** | schema |
| Prometheus endpoint and OpenTelemetry metrics/traces export | **Community** | `x:Metrics` has no enterprise flag; only `x:MetricsStore`/`x:Metric` do |
| Throttles, queue quotas, virtual queues, IP pools (`localIps`), DKIM/DKIM2, MTA-STS, TLS-RPT, DMARC reports | **Community** | schema |
| PostgreSQL/MySQL **read replicas** | **Enterprise** | schema: `readReplicas` has `enterprise: true` |
| **Sharded** blob, in-memory and lookup stores | **Enterprise** | docs/server/enterprise |
| Stored metrics/traces, dashboard, live telemetry, **alerts** (`x:Metric`, `x:MetricsStore`, `x:Trace`, `x:TracingStore`, `x:Alert`, the `metricsCalculate` task) | **Enterprise** | schema object flags |
| Multi-tenancy (`x:Tenant`), SCIM, LDAP failover / per-domain directories | **Enterprise** | schema + docs |
| **Masked email addresses** (`x:MaskedEmail`) | **Enterprise** | schema. This affects PLAN.md's "unlimited masked aliases": build it on ordinary account aliases instead. |
| AI spam classification (`x:SpamAi`, `x:AiModel`), restoring deleted items (`x:ArchivedItem`) | **Enterprise** | schema |

**Conclusion: reaching tens of millions of messages a day needs nothing from Enterprise.** Read replicas, sharded stores and the built-in alerting are useful at the very top end. You can do without them by using FoundationDB, a bigger Redis Cluster, and Prometheus + Alertmanager.

Licensing per the GitHub README: Community is AGPL-3.0, and the Enterprise features fall under the proprietary *Stalwart Enterprise License v2 (SELv2)*. It's one binary, and a license key (per domain and mailbox count) unlocks the Enterprise features.

## 3. Stateless front nodes behind a load balancer

Each node keeps only caches. Every node runs the same `config.json`, which contains just the data store. All other settings live in the shared data store, so a change made on any node applies cluster-wide. A `ReloadSettings` action reaches every node through the coordinator.

- **Identity.** Each node needs a unique `STALWART_HOSTNAME`, because node-ID leases are keyed on it. The public name is `x:SystemSettings.defaultHostname`, the same on every node, and the TLS certificate must cover it.
- **Load balancer.** Use layer 4 for SMTP/IMAP (HAProxy, NLB, or DNS round-robin) with **PROXY protocol v2**. Trust only the balancer's address in `x:SystemSettings.proxyTrustedNetworks` (or per listener with `overrideProxyTrustedNetworks`). Without this, SPF, DNSBL, rate limits and auto-ban all see the balancer's IP. For HTTP behind a TLS proxy, use `x:Http.clientIpSource = xForwardedFor` and `forwardedHops`, as `deploy/production` already does with Caddy. No session affinity is needed. Account affinity at the balancer (route each user to the same access node) reduces cache memory but is optional.
- **Health checks.** `/healthz/ready` (200 once the data store is open) and `/healthz/live` on the plain HTTP listener (8080). For mail ports, either use a TCP check or check `/healthz/ready` on port 8080, as `deploy/scale/haproxy.cfg` does.
- **Roles at scale.** Split nodes into three groups:
  - *access*: IMAP/JMAP/submission listeners plus the `pushNotifications` task.
  - *transfer*: SMTP listener plus `outboundMta` and `taskQueueProcessing`.
  - *background*: `searchIndexing`, `storeMaintenance`, `accountMaintenance`, `taskScheduler` (exactly one node), `spamClassifierTraining` (one node).

  Every role must keep the HTTP listener, or health checks fail. Roles are read at startup.
- **Settings that need a restart:** stores, caches, listeners, roles. Restart nodes one at a time and drain each one at the balancer first.
- **Two findings from running it:**
  1. Two empty nodes started at the same instant against an **empty** PostgreSQL database both try to create tables, and one fails (`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`). Start one node first. The reference compose file does this.
  2. The image's default `Log` tracer writes to `/var/log/stalwart`, which doesn't exist in the container. Add a `Stdout` tracer.

## 4. Outbound queue throughput and tuning

How the queue works in 1.0 (docs/mta/outbound/queue):

- The queue lives in the **data store**, so it is shared and survives restarts. Any node with the `outboundMta` task delivers any queued message.
- Messages are split into **virtual queues** (`x:MtaVirtualQueue`), each with its own `threadsPerNode`. Defaults on v1.0.3: `local` 25, `remote` 50, `dsn` 16, `report` 8. Each thread holds one outbound SMTP connection for the length of one delivery.
- `x:MtaOutboundStrategy` holds four expressions that pick, for each recipient or host, a `route` (local / mx / relay), a `schedule` (retry, expiry, virtual queue), a `connection` (source IPs, EHLO, timeouts) and a `tls` policy.

**Capacity formula (Little's law):** outbound msgs/s per node ≈ `threadsPerNode / average delivery time`. A delivery to a big provider over TLS takes roughly 0.3–1.5 s (connect + TLS + EHLO + MAIL/RCPT + DATA). So 50 threads give about 30–150 msgs/s per node, and 200 threads give about 130–600 msgs/s, which is 10–50M a day per node in theory. **This is an estimate, not a measurement.** I didn't send real internet mail. In practice reputation, remote rate limits and deferrals bind far earlier than threads do.

**Tuning checklist (all names verified on v1.0.3)**

| Setting | Default (v1.0.3) | Recommended for a hosted instance |
|---|---|---|
| `x:MtaVirtualQueue` `remote.threadsPerNode` | 50 | 100–200 on transfer nodes. Raise it while the `queue.back-pressure` counter keeps increasing. |
| Extra virtual queues | – | `bulk` for list/newsletter mail, a separate queue for new or unverified accounts, and `system` for signup and password emails. That way a Gmail deferral storm or a spammy account can't starve normal mail. Select them through `schedule` expressions (by `sender_domain`, `rcpt_domain`, `source`). |
| `x:MtaConnectionStrategy` timeouts | connect/greeting/EHLO/MAIL/RCPT 5 min, DATA 10 min | connect and greeting 60–120 s. Slow hosts otherwise hold threads for minutes. |
| `x:MtaDeliverySchedule` `remote` | expiry 3 days (`259200000`), default retries | Fine. Users expect about 3–5 days. |
| `x:MtaQueueQuota` (global) | **100,000 messages / 10 GiB** | **Raise it before 1M a day.** A day of Gmail deferrals at 10M a day would fill it, and every new message would get `452 4.3.1 Mail system full`. Add a **per-sender** quota as well (`key: {sender}`, for example 1,000 queued messages) so one compromised account can't fill the queue. |
| `x:MtaOutboundThrottle` | none | Per-provider pacing keyed on `mx` with `match: ends_with(mx, '.google.com')` and similar. In 1.0 throttles are **rates only** (count/period). Concurrency per destination comes from the threads of the virtual queue it's routed to. |
| `x:DnsResolver` | system | A local caching resolver (unbound) on every transfer node. DNS sits on the hot path both ways (MX, SPF, DKIM, DMARC, DNSBL, MTA-STS). The dev smoke test shows this: the first 10 messages after a cold start waited about 9 s each for DNS. |

## 5. Multiple outbound IPs, IP pools and warm-up

- **Pools.** `x:MtaConnectionStrategy.localIps` holds a list of `{localIp, ehloHostname}`. Stalwart **picks one at random per connection**, from the same address family as the MX. Make several strategies, for example `pool-trusted`, `pool-new` and `pool-system`, and select one with the `connection` expression in `x:MtaOutboundStrategy`. Every IP needs forward-confirmed reverse DNS: the PTR resolves to the EHLO name, which resolves back to the IP.
- **Warm-up.** Stalwart has **no warm-up scheduler** (stated in its docs). The documented method is an `x:MtaOutboundThrottle` with `key: {localIp: true}` and `match: local_ip == '203.0.113.11'`, whose `count` you raise every day. The docs warn about a catch: when that IP's limit is hit, the connection is **postponed, not moved to another IP**. Keep new IPs in their own pool and send only part of the traffic through it.
- **A typical schedule per IP, per big provider (Gmail, Outlook, Yahoo):** about 50–100 messages on day 1, doubling every day or two while bounces stay under 2% and complaints near zero. Full volume takes 4–8 weeks. Watch Google Postmaster Tools and Microsoft SNDS daily. This is industry practice, not a Stalwart feature.
- **How many IPs.** 2–4 at 100k a day; 8–16 (a /28) at 1M a day; a /24 or several /26s split into pools at 10M+ a day. One IP can carry a lot of good mail. More IPs are about containing damage, not raw throughput.
- **IPv6.** Gmail requires PTR records on v6 too, and a v6 range gets its reputation as a whole. `deploy/production` already avoids AAAA. Keep sending over IPv4 until v6 PTRs are set up.

## 6. Deliverability at volume

A free mail provider is different from a newsletter ESP. **All users share the provider's domain, so the domain is a "bulk sender" in Gmail's eyes once it sends more than 5,000 messages a day to Gmail.** The rules below therefore apply to the hosted domain as a whole, and one spammer damages every user. Rules as published:

**Gmail sender guidelines** (support.google.com/a/answer/81126) for senders above 5,000 messages a day to personal Gmail:

- SPF **and** DKIM.
- DMARC with at least `p=none`, **aligned** with the From domain.
- Valid forward and reverse DNS.
- TLS.
- RFC 5322-compliant format.
- **One-click unsubscribe (RFC 8058)** for marketing and subscribed mail, honoured within 2 days.
- User-reported spam rate in Postmaster Tools **below 0.3%**, with under 0.1% as the target.

Google said it would step up enforcement, including rejections, from November 2025 (per Google's sender FAQ; recheck).

**Yahoo** (senders.yahooinc.com/best-practices) has the same set of rules: SPF + DKIM + DMARC, one-click unsubscribe, and a complaint rate under 0.3%.

**Microsoft Outlook.com** (techcommunity.microsoft.com, Apr 2025, effective May 5, 2025): domains sending more than 5,000 messages a day must pass SPF, DKIM and DMARC (`p=none` or stricter, aligned). Non-compliant mail goes to Junk first and may be rejected later.

**What Stalwart does and doesn't do (verified)**

| Item | Stalwart 1.0 | Action for OpenMail |
|---|---|---|
| DKIM signing | `x:MtaStageData.dkimSignDomain`. By default it signs with `sender_domain` for local domains and authenticated senders. `x:DkimSignature` supports DKIM1 and DKIM2, with rotation stages. | Already in use (`install.sh` generates keys). Plan key rotation. |
| SPF / DMARC alignment | The envelope sender is the user's address, so it aligns with the From domain. | Publish `p=quarantine`, then `p=reject`, once reports look clean. |
| DMARC/TLS/SPF reports | Sends aggregate reports (`x:DmarcReportSettings`, `x:TlsReportSettings`) and parses incoming ones (`x:DmarcExternalReport`, `x:TlsExternalReport`). Inbound report addresses default to `postmaster@*`. | Keep postmaster@ routed as `install.sh` does. |
| **ARC** | **Verifies only** (`x:SenderAuth.arcVerify`, default `disable`). The docs say Stalwart **no longer adds ARC seals** and relies on DKIM2 instead. | Set `arcVerify` to `relaxed`. Forwarded and list mail from us won't carry an ARC seal, which is an accepted gap. |
| MTA-STS / TLS-RPT | `x:MtaSts` serves our policy. Outbound honours others' MTA-STS (`x:MtaTlsStrategy.mtaSts`). TLS-RPT is sent and received. DANE is disabled unless the resolver validates DNSSEC (seen as a startup warning). | Publish `_mta-sts` and `_smtp._tls` records (`check-dns.sh` already covers them). |
| **BIMI** | Nothing to do in Stalwart: it's DNS plus an SVG Tiny-PS logo. | Needs DMARC enforcement (`quarantine`/`reject`, pct=100). Gmail's checkmark also needs a VMC or CMC certificate, roughly $1k+/year. Do it after DMARC is at `reject`. |
| **List-Unsubscribe one-click** | It's a header the *sender* adds. Person-to-person mail doesn't need it. | Needed only if we host mailing lists or newsletters (`x:MailingList`). The web client already shows one-click unsubscribe for mail we *receive*. |
| **Feedback loops (FBL)** | ARF reports sent to us are parsed and stored as `x:ArfExternalReport`. | Sign up for Yahoo CFL (DKIM-based), Microsoft JMRP and SNDS, and Google Postmaster Tools. Gmail's FBL is meant for ESPs using a `Feedback-ID` header and is optional for us. Add a small job that polls `x:ArfExternalReport` and **suspends accounts** whose complaint rate rises **(to build)**. |
| **Bounce handling / suppression** | DSNs are generated, and `x:QueuedMessage` exposes delivery state. I found **no built-in suppression list** in the 1.0 schema. | For a mailbox provider, per-account bounce rate is the abuse signal, more than a global suppression list. Use `x:WebHook` delivery events or the queue API to compute it per account and suspend accounts that send to many invalid addresses (a "list-washing" pattern). |

## 7. Relays (SES, Postmark, Mailgun, Brevo…)

You can do this today. `install.sh --relay` already creates an `x:MtaRoute` of type `Relay`, and route expressions can mix approaches, for example "relay only after two failed direct attempts" or "relay only for `sender_domain == 'x'`" (recipes in docs/mta/outbound/strategy).

| Option | Cost (list price, approx.) | Fit |
|---|---|---|
| Amazon SES | about $0.10 per 1,000 → $1,000 per 10M | Cheapest at volume, but SES expects you to keep bounces under about 5% and complaints under about 0.1%, and suspends senders who don't. A free public provider will hit that unless abuse control is solid. |
| Postmark | about $1–1.25 per 1,000 at volume | Transactional only, with strict content rules. Good for **system mail** (signup, password reset). Not for user mail. |
| Mailgun / SendGrid / Brevo / SMTP2GO | $0.3–1 per 1,000 | Most of their terms forbid relaying mail for untrusted end users of a free service. Read the AUP. |

**Recommendation.** Send directly from your own IPs (the whole point of the project). Use a relay only for **system mail** (signup, password resets, so they reach users even when IP reputation dips) and optionally as a **fallback** route for paid accounts. Self-hosters on clouds that block port 25 keep using `--relay` as they do now.

## 8. Recipient limits (the 150-recipient requirement)

Measured on the dev server (v1.0.3, default settings):

- **SMTP submission** (Thunderbird, phones, `swaks`, port 465): `x:MtaStageRcpt.maxRecipients` defaults to **100**. Recipient 101 onwards gets `455 4.5.3 Too many recipients.` Tested: 100 accepted, 50 refused. RFC 5321 allows the client to resend to the rest, but many mail apps just show an error. **150 recipients fails today for IMAP/SMTP users.**
- **JMAP `EmailSubmission/set`** (our web client): **150 envelope recipients were accepted** with the same default, and all 150 were processed. The SMTP-stage limit doesn't apply to JMAP. I couldn't find a JMAP recipient cap in the schema **(unverified whether one exists higher up)**.
- **Other limits that matter:**
  - `x:MtaStageData.maxMessages` is 10 per SMTP session (affects bulk clients, not people).
  - `x:MtaStageData.maxMessageSize` is 100 MiB.
  - The default **inbound throttle** "Sender address to recipient throttle" (`senderDomain`+`rcpt`, 25 per hour) also applies to authenticated users (per the docs). One user emailing the same colleague 26 times in an hour is deferred. `deploy/dev-setup.mjs` turns it off for that reason.

**What to set** (applied in `deploy/scale/setup.mjs`):

```json
"x:MtaStageRcpt": { "maxRecipients": { "match": { "0": { "if": "!is_empty(authenticated_as)", "then": "500" } }, "else": "100" } }
```

- **Authenticated:** 500 per message. Gmail's personal limit is about 500 recipients per message; Google Workspace allows up to 2,000 per message (500 external) and about 10,000 recipients a day (support.google.com/a/answer/166852).
- **Unauthenticated (port 25):** stay at 100. That's the RFC minimum, and senders split larger lists themselves.
- **Pair the per-message limit with a per-account daily cap on external recipients.** Without one, 500 per message becomes a spam cannon (section 10).
- **Outbound side:** when Gmail or Outlook refuse recipients beyond their own per-transaction limit (they return a 452 for the rest), Stalwart treats those recipients as temporary failures and retries them **(unverified for splitting within one transaction; behaviour is per-recipient status in the queue)**.

## 9. Monitoring

- **Prometheus** (Community): `x:Metrics.prometheus = {"@type":"Enabled","authUsername":…,"authSecret":…}` serves `/metrics/prometheus` on every HTTP listener. **Each node serves only its own metrics**, so scrape all nodes. This was verified on the cluster: it returns 401 without credentials and data with them, for example `stalwart_delivery_completed_total`, `stalwart_queue_back_pressure_total`, `stalwart_message_ingest_spam_total`.
- **OpenTelemetry** (Community): `x:Metrics.openTelemetry` (`Http`/`Grpc`, push every 1 min by default), and the `OtelHttp`/`OtelGrpc` variants of `x:Tracer` for traces. Only nodes with the `metricsPush` role task push.
- **Built-in dashboard, stored history and alerts are Enterprise.** Use Prometheus + Alertmanager + Grafana instead.
- **Alerts worth having:**
  - queue size (`queue.count`) and `queue.back-pressure`
  - `queue.quota-exceeded`
  - delivery failure ratio per provider
  - `delivery.rate-limit-exceeded`
  - `store.data-write-time` p99 and `store.pool-error`
  - `dns.lookup-time`
  - inbound `smtp.rate-limit-exceeded`
  - auth failures and bans
  - outside Stalwart: blocklist presence (Spamhaus, Barracuda, SpamCop) for every outbound IP, Postmaster Tools spam rate, SNDS colour

## 10. Abuse controls for a free public provider

These matter more than anything else here. Without them, IP reputation collapses within days of opening signups.

1. **Signup.** Already in place in `signup/`: invites, per-IP limits, Turnstile. Add email or phone verification before the account may send externally. Launch invite-only, as PLAN.md already says.
2. **Tiered sending limits.** In Stalwart 1.0, use `x:MtaInboundThrottle` keyed on `authenticatedAs` (counted cluster-wide in Valkey, approximately). If the `match` expression uses `rcpt_domain`, it's checked at **each RCPT TO**, so it counts recipients rather than messages:
   ```json
   { "description": "Per-account daily recipient cap", "key": {"authenticatedAs": true},
     "match": {"else": "!is_empty(authenticated_as) && !is_local_domain(rcpt_domain)"},
     "rate": {"count": 2000, "period": 86400000} }
   ```
   For a tighter tier for **new accounts**, add a second throttle whose match includes `key_exists('new-accounts', authenticated_as)`. The signup service adds the account to that in-memory lookup list (`x:MemoryLookupKey`) and removes it after N days or once the account is verified. `key_exists` is used by the default config (`spam-block`), but **a custom list name is unverified**. Suggested tiers:

   | Tier | External recipients per day | Per message |
   |---|---|---|
   | New or unverified | about 50 | 20 |
   | Verified | about 500 | 500 |
   | Paid | about 2,000 | 500 |
3. **Scan outbound mail.** `x:MtaStageData.enableSpamFilter` defaults to `is_empty(authenticated_as)`, which **skips authenticated (outgoing) mail**. Set it to `true` for everything (done in `setup.mjs`). Then use the spam score: hold or reject high-scoring outbound mail with a `script` at the DATA stage or a milter/`x:MtaHook` **(design; not built)**.
4. **Per-sender queue quota** (`x:MtaQueueQuota` keyed on `sender`) and a **separate virtual queue and IP pool for new accounts**, so their mail can never use the reputation of the main pool.
5. **Detect and suspend fast.** Watch per-account bounce rate, complaints (ARF via `x:ArfExternalReport`), the outbound spam-score distribution and sudden volume spikes, then disable the account through the management API (`x:Account/set`). Monitor an abuse@ mailbox. A small "abuse daemon" next to `signup/` is the natural home for this.
6. **Auth abuse.** The defaults are already sensible: `x:Security` auth-ban 100 failures per day, `x:MtaStageAuth.maxFailures` 3, IMAP 16 sessions and 2,000 commands per minute per account.

## 11. Capacity numbers and staged plan

### Numbers with sources

| Figure | Value | Source |
|---|---|---|
| Stalwart cluster benchmark | 3 nodes × 8 vCPU, PostgreSQL + Redis. A mixed load of about 1,360 ops/s, **including about 445 inbound deliveries/s (≈38M a day)**, used about **2 cores across the cluster**. At double the load, node CPU stayed under 20%, and **the database server became the limit**. | stalw.art/docs/cluster/deployment/sizing (Stalwart's own measurements, 16 vCPU/64 GB VMs) |
| Password checks | about 26–34 ms CPU per Argon2 login, so about 500–600 logins/s on 16 vCPU | same page |
| Memory per connection | IMAP IDLE about 65–75 KB; JMAP EventSource about 28 KB | same page |
| **Dev server, measured here** | 1 node, RocksDB, Docker on a laptop, 200 messages × 2 KB, 10 connections, port 25, spam filter on: **940 msgs/s** with DNS caches warm; **21.5 msgs/s cold** (the first message on each connection waited about 9 s for DNS) | `loadtest.mjs` smoke run, 2026-11-07 |
| **2-node cluster, measured here** | HAProxy → 2 nodes → PostgreSQL + SeaweedFS S3 + Valkey, all on the same laptop: **480–570 msgs/s** warm (p50 14–16 ms, p95 about 40–50 ms); 20–42 msgs/s on the first cold run | same |
| Outbound per node | about 30–150 msgs/s at the default 50 threads; 130–600 at 200 threads | estimate (Little's law, 0.3–1.5 s per delivery). Not measured. |

The laptop numbers measure **acceptance** (SMTP, spam filter, queue write and local delivery on one machine). They show the software path and that the scripts work. They are not capacity figures for production.

### Volume

| Daily volume | Average rate | Peak rate (about 10× average) |
|---|---|---|
| 100k/day | 1.2/s | about 12/s |
| 1M/day | 12/s | about 120/s |
| 10M/day | 116/s | about 1,200/s |
| 30M/day | 350/s | about 3,500/s |

### Stage 1: 1 node, about 100k messages a day

- **Hardware.** 1 VM with 4–8 vCPU, 16 GB RAM and 200 GB+ NVMe, or object storage for blobs. 2–4 IPv4 addresses with PTR records. Port 25 open.
- **Software.** Today's `deploy/production` stack, **but on PostgreSQL** (same host is fine). Migrating off RocksDB later means a data migration, so don't put real users on RocksDB if the instance will grow.
- **Settings.**
  - `maxRecipients` 500 for authenticated users.
  - Per-account daily caps.
  - Outbound spam scan on.
  - Queue quota per sender.
  - Prometheus on.
  - A Stdout tracer.
  - A local unbound resolver.
- **Deliverability.** SPF/DKIM/DMARC (`p=none` → `quarantine`), MTA-STS, TLS-RPT. Register with Postmaster Tools, SNDS/JMRP and Yahoo CFL. Warm up the IPs over 4–6 weeks.
- **Why it's enough.** 12/s at peak is about 1% of what one node accepts, and the default 50 outbound threads are plenty.

### Stage 2: 3 nodes, about 1M messages a day

- **Stalwart.** 3 × (8 vCPU, 16–32 GB), all roles on every node. HAProxy (or a cloud NLB) with PROXY v2, in an active/passive pair (keepalived) or managed. `remote.threadsPerNode` 100–200.
- **Shared services.**
  - PostgreSQL: primary + synchronous standby, 8–16 vCPU, 32–64 GB, NVMe, with Patroni or managed.
  - S3: managed, or a 3-node Garage/Ceph cluster.
  - Valkey: 3 nodes with Sentinel. Coordinator `Default`.
- **Mail settings.**
  - Global queue quota at about 1–2M messages.
  - Separate virtual queues: remote, bulk, new-accounts, system.
  - IP pools: trusted / new / system, 8–16 IPs.
  - Relay for system mail.
  - Per-provider `mx` throttles tuned from deferral rates.
- **Operations.** Prometheus + Alertmanager + Grafana. Blocklist monitoring. The abuse daemon (ARF and bounce-rate based suspension). Rolling restarts.
- **Why it's enough.** 120/s at peak is about a quarter of what Stalwart's benchmark shows for a similar 3-node cluster. Each node can be lost without stopping service.

### Stage 3: N nodes, 10M+ messages a day

- **Roles.** Split the nodes:
  - *transfer*: 4+ nodes for SMTP in/out, about 200 threads each, scaled on `queue.back-pressure` and queue age.
  - *access*: sized on concurrent IMAP/JMAP connections and logins.
  - *background*: 2 nodes for indexing and maintenance; `taskScheduler` on one only.
  - Push sharding (`STALWART_PUSH_SHARD`) once push fan-out shows up in latency.
- **Data store.** When one PostgreSQL primary's write latency (`store.data-write-time`) becomes the limit (the benchmark suggests about 900 deliveries/s on its hardware), move to **FoundationDB** (open source, scales horizontally). The alternative is Enterprise read replicas, which don't help much with write-heavy mail ingest. Move search to Meilisearch or Elasticsearch.
- **Shared services.** Valkey Cluster. Optionally NATS as the coordinator. S3 with replication.
- **Network.** A /24 or several, across 2+ providers or locations, so one provider's network-wide block doesn't take everything down. Per-pool warm-up. A dedicated deliverability on-call.
- **Enterprise worth considering here, not required:** read replicas, sharded in-memory/blob stores, built-in alerts.

## 12. What I could not verify

- **Real internet delivery throughput** (outbound msgs/s to Gmail, Outlook and Yahoo). It's estimated from thread count and latency. Running it needs real IPs, PTR records and warm-up.
- Whether JMAP `EmailSubmission` has **any** recipient cap above 150, and whether **inbound throttles keyed on `authenticatedAs` count JMAP submissions** (web client), or only SMTP AUTH sessions. Test both before relying on the per-account cap for webmail users.
- Whether a custom `key_exists('<list>', authenticated_as)` lookup list works in throttle `match` expressions (the pattern exists for `spam-block`).
- How Stalwart splits a single 150-recipient delivery when a remote MX accepts only N recipients per transaction (I expect per-recipient temporary failures followed by retries, but didn't test it).
- Whether Stalwart reuses one SMTP connection for several messages to the same MX. This affects the Little's-law estimate.
- FoundationDB, NATS, Redis Sentinel/Cluster and roles (`STALWART_ROLE`): these are documented and present in the schema, but not run here. The reference cluster uses PostgreSQL, Valkey (single) and the coordinator `Default`, with no roles.
- The provider rules (Gmail, Yahoo, Microsoft) are quoted from their pages and third-party summaries as of today. Gmail's Nov 2025 enforcement ramp in particular should be rechecked.
- Relay prices are approximate list prices.
- Whether the PostgreSQL first-start table-creation race happens on every multi-node first start (seen once here, with two nodes started at the same moment).

### Sources

- Stalwart docs (1.0): https://stalw.art/docs/cluster/ · /cluster/deployment/sizing/ · /cluster/deployment/storage/ · /cluster/configuration/roles/ · /cluster/configuration/node-id/ · /cluster/configuration/load-balancing/ · /cluster/coordination/ · /mta/outbound/queue/ · /mta/outbound/rate-limit/ · /mta/outbound/connection/ · /mta/outbound/strategy/ · /mta/outbound/quota/ · /mta/inbound/rcpt/ · /mta/inbound/rate-limit/ · /performance/mail-throughput/ · /performance/cluster/ · /performance/data-store/ · /telemetry/metrics/prometheus/ · /telemetry/metrics/opentelemetry/ · /mta/authentication/arc/ · /mta/reports/tls/ · /server/enterprise/
- Stalwart license: https://github.com/stalwartlabs/stalwart (AGPL-3.0 + SELv2)
- Live schema: `GET /api/schema` on stalwartlabs/stalwart:v1.0.3
- Gmail sender guidelines: https://support.google.com/a/answer/81126 · Workspace sending limits: https://support.google.com/a/answer/166852
- Yahoo sender best practices: https://senders.yahooinc.com/best-practices/
- Microsoft Outlook high-volume sender requirements: https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730 · https://substrate.office.com/ip-domain-management-snds/Postmaster/Policies
- RFC 5321 §4.5.3.1.8 (accept at least 100 recipients), RFC 8058 (one-click unsubscribe), RFC 8460 (TLS-RPT), RFC 8461 (MTA-STS), RFC 8617 (ARC)

---

## Appendix: the reference cluster (`deploy/scale/`)

```
deploy/scale/
  docker-compose.yml    haproxy → stalwart-1, stalwart-2 → postgres, seaweedfs (S3), valkey
  config.json           the per-node data store definition (PostgreSQL); everything else is in the DB
  haproxy.cfg           L4 + PROXY v2, health check = /healthz/ready on :8080
  seaweedfs-s3.json     S3 credentials for the blob store
  setup.mjs             applies every setting below via the management API, then restarts nodes one by one
  loadtest.mjs          SMTP acceptance load tester (no dependencies)
```

Run it:

```sh
docker compose -f deploy/scale/docker-compose.yml up -d
node deploy/scale/setup.mjs --no-inbound-limits   # flag = dev only, so one-IP load tests aren't throttled
node deploy/scale/loadtest.mjs --port 12525 -n 200
docker compose -f deploy/scale/docker-compose.yml down -v   # remove everything
```

Settings `setup.mjs` applies (all object and field names checked against the v1.0.3 schema, and all applied successfully on a fresh cluster):

| Object | Value | Why |
|---|---|---|
| `x:Tracer` | create `Stdout`, level info | The image's default log path doesn't exist |
| `x:BlobStore` | `S3`, bucket `stalwart`, `region: {Custom, url: http://seaweedfs:8333}`, secret from env | Shared blobs. The bucket must be created through the S3 API first (SeaweedFS quirk, below). |
| `x:InMemoryStore` | `Redis`, `redis://valkey:6379` | Shared counters and locks |
| `x:Coordinator` | `Default` (reuse the Redis connection) | Must be set after the Redis in-memory store |
| `x:SystemSettings` | `defaultHostname: mx.openmail.test`, `defaultDomainId`, `proxyTrustedNetworks: {172.30.0.10/32}` | One public name. Trust PROXY headers only from HAProxy. |
| `x:MtaStageRcpt.maxRecipients` | 500 if authenticated, else 100 | The 150-recipient requirement |
| `x:MtaStageData.enableSpamFilter` | `true` | Scan outbound mail too |
| `x:MtaVirtualQueue` `remote` | `threadsPerNode: 200` | Outbound concurrency |
| `x:MtaInboundThrottle` | per-account daily external-recipient cap, 2,000 | Abuse control |
| `x:Metrics.prometheus` | `Enabled` with Basic auth | Monitoring |
| `x:Domain`, `x:Account` | `openmail.test`, `alice` | So `loadtest.mjs` works the same as on dev |

Verified on the running cluster:

- Both nodes leased IDs (`x:ClusterNode`: `0=stalwart-1 (active), 1=stalwart-2 (active)`).
- 400 messages accepted through HAProxy were visible from **both** nodes over JMAP.
- Stalwart logged the client address from the PROXY header, not HAProxy's.
- Prometheus required auth and served metrics.

Problems found along the way, fixed in the files:

1. Simultaneous first start of two nodes against an empty database: table-creation race. `stalwart-2` now waits for `stalwart-1` to be healthy.
2. SeaweedFS 3.97 acknowledges PUTs into a bucket made with `weed shell` while its S3 gateway runs, then returns 404 on GET. Stalwart's `verifyAfterWrite` caught it ("object not visible to read path"). Fix: create the bucket with S3 `CreateBucket` first.
3. HAProxy needs a few seconds after node restarts to mark the nodes UP. `setup.mjs` waits on the HAProxy health URL.

**Not production:** fixed passwords, no TLS certificates (TLS ports 465/993 have no cert), a single Valkey/PostgreSQL/SeaweedFS instance, everything on one host, and `STALWART_RECOVERY_ADMIN` left set.
