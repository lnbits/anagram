# Restore and resume relay traffic

## Scope and method

The baseline is commit `25b9dcc`. The comparison uses the same local relay proxy and browser
fixture: a saved direct contact, accepted DM history, an owned group, and a fresh browser
context restoring the same account. The original runtime was run from an isolated archive;
only test hooks and instrumentation were copied into that archive. No runtime optimization
was included in the baseline. The strict changed-runtime relay allows 8 REQ/EVENT frames per
100 ms per client connection. Frame captures contain protocol identifiers and filters only.

Fresh-login measurement ends after saved contacts, group and recent messages are visible.
Complete-history measurement additionally waits for the 90-day backfill to finish. Resume is
measured after that backfill so unrelated ongoing history traffic cannot be attributed to
resume. The separate immediate-login send scenario does not wait for history completion.
EVENT counts are outbound publications; received history EVENT frames are recorded separately.
Counts are fixture measurements, not a prediction for accounts with different routing or history.

## Measured traffic

| Scenario | Baseline REQ | Changed REQ | Baseline / changed EVENT | Baseline / changed connections |
| --- | ---: | ---: | --- | --- |
| Fresh passive login | 40 | 14 | 0 / 0 | 1 / 1 |
| Complete 90-day restore | 55 | 26 | 0 / 0 | 1 / 1 |
| Healthy lightweight resume | 9 | 0 | 0 / 0 | 0 / 0 |
| DM publication after restore | 0 | 0 | 2 / 2 | 0 / 0 |

Maximum concurrent WebSockets in the single-client fixture: one per relay before and after.
Recipient and self-copy gift wraps have different IDs; relay retries reuse the saved ID for
the corresponding scope. A reconnected relay received one retry, and the unrelated relay
received zero EVENT frames.

## Removed work

- Startup and reconnect orchestration converge on desired subscriptions. A signature is reserved
  before asynchronous connection setup; concurrent callers share setup and initial EOSE.
- Healthy resume retains existing subscriptions. Explicit unhealthy recovery is separate from
  routine reconciliation. NDK automatic regrouping is disabled for explicitly routed subscriptions.
- Relay-store hydration is suppressed as a refresh trigger, and real setting changes use one
  reconnect orchestration path. Signed-out startup does not hydrate persisted relay settings.
- My Relay List and private contact list restore from their retained, all-age live subscriptions.
  Unchanged snapshots do not schedule another subscription pass.
- Contact hydration batches profile kind 0 and relay kinds 10002/10050 by known scope. My Relay
  List owns the self kind-10002 snapshot; group member profiles join batched profile hydration.
  Older initial snapshots cannot overwrite newer persisted profile or relay metadata.
- The pre-backfill `refreshAllStoredContacts()` network pass and recent-chat network refresh
  are removed. Backfill uses restored local routing state.
- Group contact refresh fetches relay metadata once. Shared roster startup no longer fetches a
  second snapshot per group. Epoch decryption changes reapply the buffered roster locally.
- DM subscriptions use independent recipient scopes and relevant read relays; group roster and
  contact authors use relevant relay buckets. Unknown routing has a limited discovery fallback.
- Epoch history subtracts live, persisted and active global coverage. Persisted invitation bounds
  include the NIP-17 timestamp overlap; new epoch discovery does not restart global backfill.
- The replay runtime owns retries. Connected-relay notifications pass a normalized URL and target
  only eligible statuses on that relay. Every lifecycle trigger observes the retry cooldown.
- Signed recipient and self-copy gift wraps are persisted before publishing and reused on retry.
  Lost acknowledgements therefore do not generate additional unique relay events.
- Passive restoration does not publish snapshots. Publications remain tied to local mutations.

## Retained requests and limits

Different replaceable resources, recipient/self ciphertexts, disjoint history windows, and
actual filter/routing changes require distinct traffic. Discovery of an unknown group or
contact can still require an initial fallback query followed by its advertised route. Manual
repair of a missing reply/reaction and explicit user refresh retain bounded queries; they are
not passive restore. A physical reconnection must reissue active REQs on the new socket. Different relevant relays
can also return the same event; keeping those read paths preserves availability and the runtime
deduplicates application by event ID.

Legacy outbound records created before wrappers were persisted cannot recover a lost original
wrapper ID. Their first retry creates and saves a wrapper; subsequent retries reuse it.
Unavailable relays cannot supply a snapshot until they connect. Live listeners remain active
for late snapshots; timeout state does not imply an empty replaceable resource.

## Validation

- `npm run quality:all`: passed. The Cordova subcheck reports a skip because `src-cordova` does not exist; web and Capacitor checks completed.
- `npm run test:unit`: 70 files, 430 tests passed.
- `npm run test:e2e:local`: all 53 tests passed (9.5 minutes), including all six existing smoke suites and four traffic scenarios.
- The baseline measurement scenario passed with `TRAFFIC_BASELINE=true` on the isolated original checkout.

Each requested smoke command also passed individually:

| Command | Result |
| --- | --- |
| `npm run test:e2e:local:session-smoke` | 2 passed |
| `npm run test:e2e:local:dm-smoke` | 18 passed |
| `npm run test:e2e:local:groups-smoke` | 13 passed |
| `npm run test:e2e:local:relays-smoke` | 4 passed |
| `npm run test:e2e:local:contacts-smoke` | 5 passed |
| `npm run test:e2e:local:auth-smoke` | 7 passed |

After the complete suite and individual smoke commands, a final cached-profile freshness guard
was added, including persistence of the event timestamp when creating the self profile. The
final tree passed `quality:all`, all 430 unit tests, and the contact smoke command again (5
passed, 45.2 seconds). The complete e2e suite was not repeated after that isolated guard.

The first complete run exposed issues in logout hydration, group identity/profile restoration,
forced reconnect overlap, and waiting for EOSE from an unavailable relay. These were fixed and
revalidated. The epoch instrumentation now waits for both initial roster listeners before
measuring their retention. The final complete run has no failures or skipped tests.

The complete HTML report was preserved at `/tmp/relay-full-e2e-report.html` before the individual
smoke runs replaced Playwright's default report. Command logs are under `/tmp/relay-*.log`.

Coverage includes concurrent creation, healthy resume, suppressed hydration watchers, unchanged
snapshots, no pre-backfill/recent-chat refresh, one group relay-list fetch, retained roster filters,
scoped author/recipient routes, active and persisted history gaps, cooldown-respecting replay,
relay-specific retry, stable recipient/self wrappers, passive zero-publication restore, and an
immediate post-login send acknowledged under the strict rate limit.
A proxy unit test also deliberately exceeds the request budget, verifies deterministic
REQ/EVENT rejection, and checks that captured frames exclude ciphertext and signatures.

## Changed files

Compared with `25b9dcc` (including changes committed during the investigation):

```text
docs/mock-relay.md
docs/relay-traffic-investigation.md
e2e/helpers.ts
e2e/relay-traffic.spec.ts
scripts/mock-relay-proxy.cjs
scripts/mock-relay-proxy.d.cts
src/services/inputSanitizerService.ts
src/services/nostrEventDataService.ts
src/services/nostrHistoryCoverageService.ts
src/stores/nostr/contactProfileRuntime.ts
src/stores/nostr/contactRelayRuntime.ts
src/stores/nostr/contactSubscriptionsRuntime.ts
src/stores/nostr/desiredSubscriptions.ts
src/stores/nostr/groupInviteRuntime.ts
src/stores/nostr/groupRosterSubscriptionRuntime.ts
src/stores/nostr/historyCoverage.ts
src/stores/nostr/myRelayListRuntime.ts
src/stores/nostr/outboundGiftWrap.ts
src/stores/nostr/outboundMessageReplayRuntime.ts
src/stores/nostr/privateContactListRuntime.ts
src/stores/nostr/privateMessageRouting.ts
src/stores/nostr/privateMessagesBackfillRuntime.ts
src/stores/nostr/privateMessagesSubscriptionRuntime.ts
src/stores/nostr/privateStateRuntime.ts
src/stores/nostr/reconnectHealingRuntime.ts
src/stores/nostr/relayConnectionRuntime.ts
src/stores/nostr/relayPublishRuntime.ts
src/stores/nostr/relaySettingsSubscriptions.ts
src/stores/nostr/startupContactSyncRuntime.ts
src/stores/nostr/subscriptionEose.ts
src/stores/nostr/subscriptionLoggingRuntime.ts
src/stores/nostr/subscriptionRefreshRuntime.ts
src/stores/nostr/types.ts
src/stores/nostr/userActions.ts
src/stores/nostrStore.ts
src/testing/e2eBridge.ts
src/types/chat.ts
src/types/contact.ts
tests/unit/contactProfileRuntime.spec.ts
tests/unit/contactSubscriptionsRuntime.spec.ts
tests/unit/desiredSubscriptions.spec.ts
tests/unit/e2eBridge.spec.ts
tests/unit/groupRosterSubscriptionRuntime.spec.ts
tests/unit/historyCoverage.spec.ts
tests/unit/mockRelayProxy.spec.ts
tests/unit/nostrRelaySubscriptions.spec.ts
tests/unit/nostrRuntimeCore.spec.ts
tests/unit/nostrRuntimeMessaging.spec.ts
tests/unit/outboundGiftWrap.spec.ts
tests/unit/outboundMessageReplayRuntime.spec.ts
tests/unit/privateContactListRuntime.spec.ts
tests/unit/privateMessagesBackfillRuntime.spec.ts
tests/unit/privateMessagesSubscriptionRuntime.spec.ts
tests/unit/privateStateRuntime.spec.ts
tests/unit/reconnectHealingRuntime.spec.ts
tests/unit/relaySettingsSubscriptions.spec.ts
tests/unit/startupContactSyncRuntime.spec.ts
tests/unit/subscriptionEose.spec.ts
tests/unit/userActions.spec.ts
```
