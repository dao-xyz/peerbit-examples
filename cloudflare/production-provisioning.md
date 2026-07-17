# One-time Cloudflare production provisioning

This runbook seeds the seven reviewed application Workers and their seven exact
`*.apps.peerbit.org` custom domains. The authoritative identities remain in
`cloudflare/deployment-policy.json`; the provisioning script independently
pins the same seven application IDs, production Workers, production hostnames,
and preview Workers so a scope change requires code and policy review. A
preview identity cannot be substituted with a duplicate, shadow, or retired
legacy Worker through policy alone. The script never creates preview Workers,
traditional Worker routes, or any resource outside that allowlist.

Cloudflare's current model separates an uploaded Worker version from the
deployment that sends traffic to it, but Wrangler refuses `versions upload`
when the named Worker does not exist yet. For a missing reviewed Worker, the
workflow therefore performs one exact-name initial `wrangler deploy` from a
temporary config with `workers_dev: false`, `preview_urls: false`, and no
routes or custom domains. It accepts that private active baseline only when
the same invocation emits one structured `deploy` record with an empty target
list and exact Cloudflare GETs prove the Worker tag, version, artifact, active
100% deployment, and both disabled public URL flags. Existing Workers retain
the separated inactive-version upload and exact 100% activation path. In both
cases the reviewed custom domain is attached last.

These are the relevant official references:

- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [`wrangler deploy`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
- [`wrangler versions upload`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-upload)
- [Worker scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)
- [Zones list API](https://developers.cloudflare.com/api/resources/zones/methods/list/)
- [Authoritative Worker routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/)
- [Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/)
- [Worker deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
- [Worker versions API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/)
- [Worker Cron Trigger schedules API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/)
- [Queues list API](https://developers.cloudflare.com/api/resources/queues/methods/list/)
- [Queue consumers list API](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/list/)
- [Worker script content API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/)
- [Worker custom-domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## Preconditions

1. Run only from `master` at the exact commit to be made the initial baseline.
   Copy its lowercase, full 40-character Git SHA; abbreviated SHAs are not
   receipts.
2. Keep GitHub's `cloudflare-production` environment protected by required
   reviewers. Its existing `CLOUDFLARE_PRODUCTION_API_TOKEN` secret must have
   the narrowly required Workers Scripts read/write access, including version,
   deployment, subdomain, domain, Cron Trigger schedule, and active script
   content reads, plus **Queue Read** for the separate account-wide Queue
   consumer inventory. It must also have **Zone Read** and **Workers Routes
   Read** for **every zone in the account**, not merely `peerbit.org`: the
   safety fence enumerates the complete account and reads each zone's
   authoritative traditional-Worker routes. Its existing
   `CLOUDFLARE_ACCOUNT_ID` secret must identify the reviewed account. The
   protected environment must also define the exact lowercase 64-hex
   `CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256` secret. Keeping both as
   environment secrets prevents the Actions runner from printing their raw
   values in its initial environment header. Establish the fingerprint from an
   independently verified full dashboard/admin zone inventory, never from the
   deployment token's permission-filtered `/zones` response. Canonical input is
   UTF-8 JSON with no trailing newline: an array of exactly
   `{"zoneId":"<lowercase-id>","zoneName":"<lowercase-name>"}` identities,
   sorted first by `zoneId` and then by `zoneName` using ascending code-point
   order. Hash that byte sequence with SHA-256. If the full inventory has not
   yet been independently established, leave production workflows blocked
   until this secret is reviewed and set.
3. Confirm that the `peerbit.org` zone is active in that account. Cloudflare
   cannot attach a Custom Domain over a conflicting CNAME, so resolve any such
   conflict manually before applying.
4. Ensure no other Cloudflare production deployment is running. Both the
   provisioning and routine deployment workflows use the
   `cloudflare-examples-production` concurrency group.
5. Never paste the API token, account ID, or a `workers.dev` hostname into an
   issue or workflow log.

## Read-only plan

Dispatch **Provision Cloudflare production once** with:

- `mode`: `plan`
- `planned_commit`: `<the exact 40-character master SHA>`
- `planned_state_digest`: `<64 zeroes>`
- `confirm`: `plan-peerbit-production-<the exact 40-character master SHA>`

For example, for planned commit
`0123456789abcdef0123456789abcdef01234567`, enter exactly:

- `planned_commit`: `0123456789abcdef0123456789abcdef01234567`
- `planned_state_digest`: `0000000000000000000000000000000000000000000000000000000000000000`
- `confirm`: `plan-peerbit-production-0123456789abcdef0123456789abcdef01234567`

The protected environment supplies credentials only to the final read-only
step. The plan reads the complete Worker and stable custom-domain inventories,
then strictly paginates every zone belonging to the exact account and reads
the authoritative traditional-Worker routes from every zone. Two complete
zone-plus-route snapshots must match exactly. The zone query explicitly asks
for `full`, `partial`, `secondary`, and `internal` zones because Cloudflare's
default omits internal zones. The Worker-list API's optional
inline `routes` field is never treated as proof of an empty route set; when it
is present it must exactly match the authoritative per-zone result. The plan
hashes the observed canonical zone identities and requires the independently
configured protected fingerprint to match. This closes the case where every
API response is HTTP 200 but the token silently sees only a subset of the
account's zones. Missing, malformed, or mismatched fingerprints fail before
mutation and are never printed. The expected fingerprint is bound into the
plan state digest, reviewed receipt, and apply-time invocation ledger; every
inspection fence recomputes and rechecks it. Zone status, type, and complete
route inventories remain separately bound as dynamic state in that digest.
The plan also reads the live public-subdomain state, deployments, every
deployable version ID, immutable Worker tags, Tail consumers, Logpush state,
Cron schedules, active service-binding targets, and every Queue plus its
separate consumer attachments. The Queue list is paginated and every complete
account snapshot must be observed twice without change. The digest also binds
the exact
Cloudflare account ID so an account-variable change cannot reuse a receipt. It
prints the full planned commit, reviewed
Worker names, public custom domains, proposed actions, and a canonical
`PLAN_STATE_SHA256` receipt. It sends no Cloudflare mutation.

Before credentials are exposed, the workflow dry-runs each of the seven exact
Wrangler bundles and creates a canonical artifact manifest. Each dry run must
contain exactly one self-contained ES module: the upload config sets both
`no_bundle: true` and `find_additional_modules: false`, explicitly disables
source-map upload, and the receipt rejects any auxiliary JavaScript, Wasm,
source-map, text, or data output. Each manifest
hashes the exact module name, MIME type, bytes, normalized route-free
runtime/config (including static-assets behavior), and every static-asset input
path, byte length, and SHA-256 (including `release.json`; processing inputs such
as `_headers` are marked non-public). The workflow also writes those exact
canonical manifest bytes to
`/peerbit-deployment-manifest.json` in the site's asset input. The artifact
manifest digest is included in the plan receipt, so rebuilding different code,
configuration, or assets cannot reuse a reviewed account-state receipt.

Review all seven rows. Expected actions for a missing first-run Worker are an
exact route-free private initial deploy, public-subdomain disable, domain
attachment, and live verification. An existing Worker instead shows a fresh
route-free version upload, public-subdomain disable, exact 100% activation,
domain attachment, and live verification. Each existing allowlisted preview
Worker with either public flag
enabled has an explicit `disable-public-subdomains` action; a missing preview
has no action and is never created. Any unknown `peerbit-examples-*` Worker,
traditional route, wrong domain owner, split deployment, Tail consumer,
Logpush attachment, Cron Trigger, queue/service attachment on a managed Worker,
inbound service binding, Queue consumer attachment targeting any managed
production or preview Worker, a route that references an unknown Worker, any
inaccessible/incomplete/unstable account zone or route inventory, or malformed
response blocks the run. Old
inactive versions are listed as quarantined state: their annotations are never
accepted as proof that this invocation uploaded them. The inspection records
every production Worker's existence, immutable Worker tag, active and
deployable version IDs, subdomain flags, schedules, domain state,
artifact-manifest digest, the complete canonical account zone-and-route
inventory, and the canonical account Queue-consumer inventory in the signed
plan receipt and apply-time invocation ledger.

## Confirmed apply

After reviewing the plan, copy both the exact full SHA and the exact lowercase
`PLAN_STATE_SHA256` printed by that plan. Dispatch the same workflow from that
unchanged `master` commit with:

- `mode`: `apply`
- `planned_commit`: `<the exact full SHA copied from the plan>`
- `planned_state_digest`: `<the exact PLAN_STATE_SHA256 copied from the plan>`
- `confirm`: `provision-peerbit-production-<full SHA>-<PLAN_STATE_SHA256>`

For the example SHA above, enter exactly:

- `planned_commit`: `0123456789abcdef0123456789abcdef01234567`
- `planned_state_digest`: `<the 64-character digest printed by the plan>`
- `confirm`: `provision-peerbit-production-0123456789abcdef0123456789abcdef01234567-<the same 64-character digest>`

Both workflow jobs validate the 40-character commit and 64-character state
receipt, require the commit to equal checked-out `github.sha`, and bind the
apply confirmation to both. The provisioning CLI independently repeats those
checks and recomputes the canonical account-state digest before dispatching any
mutation. Any Worker tag, active/deployable version, route, domain, public flag,
schedule, Tail/Logpush setting, or exposed service-binding drift forces a new
reviewed plan. Artifact-manifest, zone/route, or Queue-consumer drift does the same. A
mismatch exits nonzero; it is not treated as a skipped deploy.

The workflow rebuilds all seven frontends and assets from the checked-out
commit, tests the sources, dry-runs every locked Wrangler bundle, and then:

1. Repeats the account-wide policy read before mutation and rejects unknown or
   retired namespace Workers, any managed traditional route, and every
   unreviewed Custom Domain attachment. This initial read creates one
   invocation-wide production ledger: existence, immutable Worker tag, exact
   active/deployable versions, attachments, and domain state are never silently
   rebaselined. A Worker missing at that read must remain missing until its own
   proved initial private deploy.
2. Disables both public flags on every existing allowlisted preview **and
   production** Worker. It requires exact `enabled: false`,
   `previews_enabled: false` GET evidence for all of them before the first
   production deployment mutation. Missing Workers remain missing. Ambiguous
   responses continue only if that exact GET postcondition is observed.
3. Rechecks the complete ledger, exact preview identities, zero Cron schedules,
   zero Tail/Logpush attachments, active service-binding inventory, the exact
   account-wide Queue-consumer inventory, complete authoritative account
   zone-and-route inventory, and global false/false public-URL fence before
   every initial deploy, version upload, activation, and domain attachment and
   after every mutation.
   An added/deleted zone, route drift, or a change to an earlier or unrelated
   site or Queue stops the invocation; it is never accepted as a new baseline.
4. Revalidates every artifact manifest immediately before mutation and sends
   its exact prebuilt module with bundling disabled. A Worker missing from the
   reviewed invocation ledger is initialized only with exact-name route-free
   `wrangler deploy`; its private config disables both public URL settings and
   omits every route/custom-domain field. The workflow requires exactly one
   same-invocation structured `deploy` record with an empty target list, then
   direct GETs must prove its immutable Worker tag, exact active version at
   100%, one reviewed deployable version, no domain, the reviewed runtime and
   artifact, and no attachment drift. An existing Worker instead receives one
   fresh inactive route-free version through `wrangler versions upload`,
   followed later by exact activation. Every version tag contains a
   cryptographically random invocation nonce. No inactive version from an
   earlier or ambiguous attempt is ever reused, even if its annotations look
   exact. A Worker/version identity is learned only when structured evidence
   from this exact Wrangler invocation and a direct exact-version GET agree on
   Worker tag, version ID, nonce-tag/message, runtime settings
   (including cache, limits, migrations, placement, and usage model), reviewed
   bindings, the artifact digest binding, and the version resource fingerprint.
   For an omitted limits config, only Wrangler's equivalent omitted or plain
   empty-object response is accepted; any limit field is rejected. Explicitly
   configured limits must match exactly.
   It also downloads that exact version through the content API and
   requires the multipart body to contain exactly the one reviewed ES module,
   with no auxiliary modules or source maps. The same digest is carried by the
   version message, same-invocation evidence, plan, and apply ledger.
5. Allows only the just-mutated Worker as a narrow public-URL transient, then
   immediately disables both public flags and restores the global fence before
   any other mutation.
6. For an existing Worker, activates exactly the tagged inactive version at
   100% through the deployments API. For a newly initialized Worker, requires
   the initial private deploy to remain the exact active version. It then
   downloads content for that exact version ID again and requires the
   entrypoint name, MIME type, length, SHA-256, and complete one-module
   multipart set to match the reviewed artifact.
7. Attaches exactly one reviewed Custom Domain to each Worker, after all
   Workers have a verified active baseline. It never creates a traditional
   route.
8. Reuses the routine production deployment's strict account-wide attachment
   policy, verifies the exact served artifact manifest and exhaustively hashes
   every public live asset (including `release.json`) against it, runs the same
   file-share relay and media-range browser smokes, then
   rereads exact Worker identity, version resource fingerprint, domain,
   authoritative account zones/routes,
   schedule, Tail/Logpush, service-binding, Queue-consumer, active-module, and
   subdomain state, including every existing allowlisted preview Worker.

A rerun is deliberately not idempotent at the version-upload layer for Workers
that already exist: after a new plan is reviewed, it uploads and proves fresh
nonce-bound versions. This prevents a failed invocation's unproved leftover
version from becoming trusted on a later run. Existing active versions and
quarantined inactive IDs remain in the plan state until the fresh versions are
proved and promoted. A Worker is eligible for the initial-deploy path only when
the reviewed state digest proved that exact identity absent. The state-digest
schema is revised whenever these transition semantics change, so an older plan
receipt cannot authorize a newer implementation. Use the routine transactional
production workflow after the initial baseline exists.

## Ambiguous responses and recovery

Cloudflare does not expose compare-and-swap preconditions for version uploads,
deployments, public-subdomain settings, or custom-domain attachment. Every
post-dispatch transport, HTTP, malformed-body, empty-body, or invalid-evidence
failure is therefore ambiguous. The script continues only when subsequent
exact GETs prove the requested version tag, immutable Worker identity, 100%
deployment, disabled subdomains, or custom-domain owner. Otherwise it stops
with manual-recovery guidance.

Cloudflare exposes exact script content for a requested version ID, but it does
not expose an exact-version static-assets manifest that this workflow can
compare before activation. Consequently, the inactive-version GET proves the
reviewed runtime, handlers, cache options, bindings, artifact digest, and exact
one-module script set. The artifact receipt binds every reviewed asset byte and
static-assets behavior setting, while exact deployed asset-byte and behavior
proof is necessarily performed through the custom domain after activation. The
served manifest plus exhaustive path/length/SHA-256, 404, HTML, header, and
Worker-first range/cache checks detect a wrong asset upload, but detection is
post-activation. Any exact-version module, served-manifest, or live-asset
mismatch is therefore an explicit manual-recovery condition: stop, inspect the
named Worker's active deployment and assets, and do not blindly retry or attach
further domains.

For an initial deploy that creates a previously missing Worker, GET state alone
cannot establish that the invocation owns the new identity: another actor could
have created it concurrently. The script also requires Wrangler's structured
`deploy` evidence to name the same Worker tag and version and to report no
targets. If that evidence is lost or malformed, it never learns the Worker and
never attaches a domain. Before stopping, it still targets the independently
pinned exact Worker name to disable both public URL surfaces, requires a direct
false/false GET, and rereads the invocation-wide fence without accepting the
unproved identity or version. The manual-recovery error retains the original
deploy/proof failure and separately reports whether the exact cleanup and
global post-cleanup fence were proved. The same failure-safe cleanup runs when
Wrangler evidence is mismatched or the first post-deploy account inspection
fails.

Do not blindly rerun an apply failure. First dispatch a new read-only plan and
inspect the named Worker's versions, active deployment, routes, custom domain,
and public-subdomain settings in Cloudflare. Partial runs intentionally leave
proved inactive versions or exact active Workers in place; they do not delete
or roll back resources whose ownership cannot be proved. Once the account
matches a safe partial state, review its new state digest. The next apply keeps
old inactive versions quarantined, uses the initial private-deploy path only
for exact Workers still proved absent, and uploads a fresh version for every
Worker that exists; it never resumes by adopting the ambiguous mutation.

After all seven sites have passed routine deployments in production, remove
this one-time workflow in a separately reviewed pull request. Keep this
runbook as the audit record.

## Separate retired legacy Worker cleanup plan

`peerbit-examples-legacy-stream-preview` is not part of the deployment policy
and has no users. Provisioning deliberately does **not** delete it. Its presence
blocks the plan so an unexpected namespace resource cannot be silently
accepted.

Cleanup is a separate, explicitly approved operation:

1. Record approval using the exact phrase
   `delete-peerbit-examples-legacy-stream-preview` outside the provisioning
   workflow.
2. Read the account Worker inventory and prove the identity is exactly
   `peerbit-examples-legacy-stream-preview`. Confirm it is absent from
   `cloudflare/deployment-policy.json` and `cloudflare/sites.json`.
3. Prove it has no traditional routes, no Custom Domains, and no expected
   `*.apps.peerbit.org` hostname. Read its public-subdomain state and require
   both `enabled` and `previews_enabled` to be false. If either is true,
   explicitly disable only that Worker's public subdomains under the same
   cleanup approval and prove the exact false/false GET postcondition before
   continuing. If any attachment or consumer exists, stop and review a
   separate detachment/migration; do not broaden the deletion.
4. Delete only that exact Worker in the Cloudflare dashboard or with the
   [documented exact-script DELETE API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/).
   Do not use `force=true`, a prefix, loop, or wildcard; an attachment or
   binding refusal is a reason to stop, not something to override.
5. Read the full Worker and custom-domain inventories again, confirm only that
   exact identity disappeared, then rerun the read-only provisioning plan.

The production provisioning script contains no Worker-delete operation, so
the cleanup cannot be triggered accidentally by either `plan` or `apply`.
