prompt


cross test with other chat apps

add `Encrypted private key import using ncryptsec` on all

No relays found for this contact -> if this is the case do a refresh profile beforehand
 - keep last profile refresh in mind
- when refreshing a users's profile also use the app relays (the user might not have relays) 


mark all messages as read when opening android app

chat with contact from group
dektop app -> in group click on memeber -> should redirect to chat to this member (nothing happens now)
copy to clipboard button does not work on mobile apps

unread always at the top 


confety emoji


Priority	Number	Scenario	Why it matters
P0	9	New current group epoch / rotation	Group push notifications can silently stop after an epoch rotation because Android push still watches the old epoch pubkey.
P0	11	Group chat deleted/left	Users can keep receiving notifications for chats they removed or left. That is noisy and potentially privacy-sensitive.
P0	15	App restart / app version or FCM token change	Push registrations should be refreshed on app start/resume when enabled. Otherwise stale tokens or stale watched pubkeys can linger.
P1	12	Group relay list changed	Group delivery can degrade when the group moves relays. For push, this may require expanding the payload beyond app relays, not just refreshing.
P1	5	My Relays / NIP-65 changed	If users expect My Relays to define where they receive messages, Android push should stay aligned with that.
P2	4	App relay write-only flag changed	Current behavior over-refreshes. Worth cleaning up, but it is not a user-visible failure in most cases.



- search with @name (for groups)
- notificatinos request on desktop app
- Pin message support.
- For group chat threads for relay-status details (on the dialog) also show the epoch it sent to

- it seams that the relays of a group are lost from time to time, what can be the reason
  when adding a member to the group sometimes the relay list for the group becomes empty
- dialogs on mobile at the bottom, Dialogs on desktop at the top

- relay status for all publishing actions

- download as mobile app -> settings tab add an install ico



- Add `Edit` option for a message. The UX should match familiar chat editing patterns.


- file messages


on group restore set members the latest epoch sent invitations
- better nip51 here

- group private key is now saved as NIP78, this data structure must be standardizd so other apps can use it easily




What Reliability Work Comes Next

Build a durable outbox with automatic replay. Right now outbound relay state is tracked well in relayPublishRuntime.ts (line 145), but recovery still leans too much on manual retry. We should retry failed recipient publishes automatically with exponential backoff, jitter, retry budgets, and idempotent replay after app restart.

Make reconnect more aggressive than “re-subscribe and hope.” The watchdog is good, but after wake, focus regain, relay-set changes, or long offline windows, the app should run a targeted gap-repair pass per active or recently active chat, not just a generic live resubscribe. This is where the app should feel instant and correct after bad connectivity.

Define message success in product terms, not raw relay terms. Users care about sending, sent, needs attention, and eventually seen. Today the app records per-relay truth, which is excellent for diagnostics, but we still need a higher-level delivery state derived from those statuses so users aren’t forced to interpret relay internals.

Strengthen multi-device convergence beyond read cursors. Read state already syncs, but mute/archive/pin/draft state does not, and those are part of reliability too because mismatched device state feels broken. The private-state channel in privateStateRuntime.ts (line 2084) is the right place to extend.

Add second-layer dedupe for resend and multi-device races. Current dedupe is event_id based, which is necessary but not sufficient if the same logical message is republished with a different event id from another device or retry path. A client-generated message UUID/tag would let us collapse “same intent, different event” duplicates.

- Repair dependency holes automatically. Reactions, deletions, and replies already queue pending work when targets are missing, which is good, but the app should actively fetch missing targets around those references instead of waiting for them to arrive incidentally. That would reduce “reply to unknown” and delayed reaction/deletion consistency issues.

- Make background behavior first-class. Web currently has browser notifications, and Electron currently exposes unread badge wiring in electron-preload.ts (line 1), but production-grade reliability needs service-worker/push or equivalent background catch-up semantics, plus desktop notifications/tray behavior that survives app backgrounding.

Add “honest sync” UI. A tiny offline/reconnecting/catching-up indicator would prevent the app from looking broken during recovery windows. Reliability is partly actual correctness and partly whether the user understands what the app is doing.

Expand chaos testing. The next missing tests are long offline periods, relay flapping during send, two devices sending in the same chat simultaneously, wake-from-sleep recovery, and notification/background resume. The existing e2e base is strong enough that this should be very achievable.

If We Prioritize Ruthlessly
Start with durable outbox + auto replay, then targeted gap repair on resume/reconnect, then logical-message dedupe + multi-device convergence. Those three would move Anagram the most toward an “it just catches up and does the right thing” feel.

Do you want to rerun the local groups Playwright check with Docker and Node explicitly on PATH?
export PATH=/Applications/Docker.app/Contents/Resources/bin:/Users/moto/.nvm/versions/node/v24.15.0/bin:$PATH; /Users/moto/.nvm/versions/node/v24.15.0/bin/node ./scripts/run-e2e-local.cjs e2e/groups.spec.ts



So I’d use this order now:

Shared lifecycle/runtime consolidation
Pull foreground/background/resume logic into one runtime instead of splitting it between MainLayout, reconnect healing, and notification suppression.
Add a clean cross-platform app-state API for web, electron, and capacitor.
Native notifications
Electron desktop notifications with click-to-open-chat.
Keep browser notifications as-is, but route them through the same shared policy.
This is now more important than “browser hidden-tab notifications” because that part already exists.
Android native app-state + notifications
Wire Capacitor app lifecycle into the shared runtime.
Add Android notification channels, tap-to-open-chat, and badge/unread behavior.
I’d prioritize this before tray work if Android matters.
Push wakeups / background delivery
Android push first via FCM-style wakeups.
Web service worker/push later.
This replaces the old generic “service worker + push backend” phase, because Android is the more realistic first target here.
Tray / minimize-to-tray as an optional desktop UX pass
I would no longer keep tray bundled with Electron notifications by default.
Notifications are core reliability UX; tray is useful, but more opinionated.
