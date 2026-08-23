# Waywiser Mobile — Termux-native integration

**Date:** 2026-08-23
**Status:** Draft → implementing
**Scope:** New extension family `extensions/mobile/*` plus surgical changes to
`extensions/notify.ts` and `extensions/proactive.ts` to expose extension points.
No changes to pi core. No new production dependencies.

---

## 1. Motivation

The current Termux integration is one bit deep: `notify.ts` shells to
`termux-notification` and stops. Everything Termux:API actually offers —
bidirectional notifications, share-sheet ingest, voice capture, Doze-safe
scheduling, biometric consent, live context signals (battery, thermal, wifi,
motion) — is unused. On a phone that context IS the leverage.

## 2. Non-negotiables

1. **No pi core patches.** Every capability is a Termux CLI call spawned with
   argument arrays (no shell string concatenation), matching the existing
   `sendTermux()` posture.
2. **No new production deps.** Filesystem + `node:child_process` +
   `termux-*` binaries only.
3. **Graceful degradation.** If `termux-*` is absent (desktop, CI, no
   Termux:API app), every mobile primitive returns a null/unavailable result;
   the rest of Waywiser keeps working unchanged.
4. **Battery-honest.** No wake-lock by default. No background LLM calls.
   Context sensors are cached (60 s TTL) and never poll faster than the
   proactive tick.
5. **Callback security.** Notification `--action` / `--button*-action` strings
   never embed user data. They embed only opaque one-shot **inbox tokens**
   (hex UUIDs). The token → intent mapping lives in `~/.waywiser/inbox/<tok>.json`,
   owned by the pi process. Direct-Reply `$REPLY` is env-expanded by `dash`
   and passed as an argv element, never as a shell fragment.
6. **User consent.** Wake-lock, job-scheduler registration, notification
   listener enablement, biometric gating — all opt-in via `~/.waywiser/mobile.json`
   or `/mobile setup`.

## 3. Architecture

```
extensions/mobile/
├── index.ts          ← extension entry, /mobile command, inbox watcher
├── types.ts          ← MobileConfig, MobileContext, InboxIntent, NotifyAction
├── config.ts         ← ~/.waywiser/mobile.json read/write with defaults
├── termux.ts         ← spawnTermux() — safe wrapper, availability probe, cache
├── context.ts        ← battery/wifi/thermal/audio/network sensor, TTL-cached
├── actions.ts        ← NotifyAction → argv builder, shell-safe token strings
├── inbox.ts          ← token issue/redeem, filesystem queue, watcher → pi
├── channels.ts       ← Android notification channel provisioning
├── jobscheduler.ts   ← termux-job-scheduler registrar for the Doze-safe tick
├── wakelock.ts       ← burst/always/off wake-lock lifecycle
├── biometric.ts      ← termux-fingerprint gate helpers
├── capture.ts        ← STT + share-sheet ingest into Brain/kanban
└── signals.ts        ← ProactiveSignal providers derived from mobile context

bin/
├── waywiser-do       ← notification-button callback → inbox
├── waywiser-reply    ← Direct Reply callback → inbox
├── waywiser-approve  ← biometric-verified permission response → inbox
├── waywiser-capture  ← STT / share-sheet dispatcher → inbox
└── waywiser-tick     ← standalone Doze-safe DB reader → P0 notifications only

config/
├── mobile.example.json
└── shortcuts/
    ├── waywiser-capture      ← Termux:Widget voice capture
    ├── waywiser-briefing     ← Termux:Widget today briefing
    ├── waywiser-standup      ← Termux:Widget daily standup
    └── termux-url-opener     ← Android share-to-Termux ingest
```

## 4. Data flow — interactive notification

```
proactive.tick() ── produces Signal P1
  ↓
sendNotification(title, body, ["termux"], {actions: [...]})
  ↓
mobile.actions.buildTermuxArgs()  ← issues inbox tokens, builds argv
  ↓
spawn("termux-notification", ["--button1", "Done",
                              "--button1-action",
                              "'/prefix/bin/waywiser-do <token>'",
                              ...])
  ↓ user taps Done in shade
  ↓
Android runs the action via dash -c
  ↓
waywiser-do <token>  ← appends token consumption to ~/.waywiser/inbox/
  ↓
mobile.inbox watcher (fs.watch on the inbox dir) reads the token file
  ↓
looks up intent in ~/.waywiser/inbox/tokens/<tok>.json
  ↓
either calls a registered handler (e.g. mark card done) directly,
or pi.sendUserMessage(intent.prompt, {deliverAs: "followUp"})
  ↓
token file deleted (one-shot)
```

### Direct Reply variant

```
--button1 "Answer" --button1-action 'waywiser-reply <token> "$REPLY"'
```

`dash` expands `$REPLY` (set by Termux:API when Android returns the typed
text) as a single argv element. `waywiser-reply` writes `{token, reply: argv[2]}`
to the inbox. The watcher hydrates the original intent and calls
`pi.sendUserMessage("[reply] <reply>", …)`.

## 5. Mobile-context sensor

`readMobileContext()` returns:

```ts
interface MobileContext {
  available: boolean;              // false when termux-* absent
  atMs: number;                    // when the snapshot was taken
  battery?: { percentage: number; temperatureC: number; charging: boolean; };
  wifi?: { ssid?: string; bssid?: string; frequency?: number };
  network?: { type: "wifi" | "cellular" | "none"; metered: boolean };
  audio?: { headphonesConnected: boolean; bluetoothConnected: boolean };
}
```

Cached with a 60 s TTL. Every accessor is opt-in via config (`mobile.context.*`).
Sensor probing is parallelized and bounded (3 s hard timeout per probe).

## 6. Proactive-loop integration

`proactive.ts` gets two backward-compatible extension points:

```ts
registerSignalProvider(fn: (db, opts) => Signal[]): () => void
registerDiscretionAugmenter(fn: (signals: Signal[], ctx: MobileContext | null) => Signal[]): () => void
```

`gatherSignals()` calls existing SQL logic **plus** every registered provider
(each in try/catch so a broken provider cannot kill the tick). `applyDiscretion`
in `meta-skills.ts` remains untouched; mobile discretion is a **separate**
filter applied AFTER discretion but BEFORE delivery:

- battery < 20 % & not charging → drop everything below P0.
- battery.temperatureC > 40 → drop non-critical signals that would fire
  cost-heavy follow-ups (turn-triggering signals only, notify-only pass).
- charging + wifi-unmetered → **burst mode**: allow P3 signals that were
  otherwise dropped; hint the multi-tasking engine that heavy work is fine.
- SSID stable > 2 h → tag context; UI hint only.

## 7. Doze-safe fallback tick

`bin/waywiser-tick` is a standalone Node script (no pi, no LLM) invoked by
`termux-job-scheduler` every 15 minutes minimum (Android JobScheduler floor).
It opens `waywiser.db` read-only, runs the P0 subset of `gatherSignals()`
(goals past deadline, cards overdue), dedupes against
`~/.waywiser/mobile/tick-alerts.json` (one-hour window), and fires
`termux-notification` for anything new.

- Never fires P1–P3 (those require the running agent to be meaningful).
- Never calls `pi.sendUserMessage` (there is no pi to call).
- Refuses to run if `waywiser.db` shows a session started in the last
  `tickActiveMs` window (avoids duplicating alerts the live process
  would have delivered).

## 8. Biometric-gated approvals

When `permissions.ts` policy is `ask_user` and no dialog UI is attached, the
mobile extension emits a notification:

```
--button1 "Approve" --button1-action \
    'termux-fingerprint -t "Approve <req>" | grep -q "\"success\":true" \
     && /prefix/bin/waywiser-approve <token> yes \
     || /prefix/bin/waywiser-approve <token> no'
--button2 "Deny" --button2-action '/prefix/bin/waywiser-approve <token> no'
```

The token maps to the pending request; the watcher calls the permission
engine's callback. Failed biometrics count as an explicit deny (safer default).

## 9. Widget shortcuts

Scripts shipped in `config/shortcuts/`. `/mobile setup` prints an
`install-shortcuts` command that copies them into `~/.shortcuts/` (only on
explicit user confirmation — the mobile extension never writes there
implicitly).

- **waywiser-capture** — `termux-speech-to-text | waywiser-capture stt`
- **waywiser-briefing** — `waywiser-tick --briefing` fires an on-demand
  notification with today's overdue + goal deadlines
- **waywiser-standup** — creates a "daily standup" kanban card seeded with
  yesterday's completed cards
- **termux-url-opener** — Android's share-to-Termux entry point; posts the
  shared URL/text to the inbox with a `share-ingest` intent

## 10. Wake-lock modes

```
"wakeLock": { "mode": "off" | "burst" | "always" }
```

- **off** (default) — never acquire. Recommended for daily use.
- **burst** — the mobile extension acquires wake-lock at the start of a
  known-heavy operation (embedding batch, delegation, consolidation) and
  releases it immediately after. Bounded to 30 s per burst; releases in a
  `finally` block; releases on `process.exit`.
- **always** — acquires at session_start, releases at session_end.
  Documented as "will drain battery"; user must opt in.

## 11. Config

`~/.waywiser/mobile.json`:

```json
{
  "enabled": true,
  "interactive": true,
  "context": {
    "battery": true,
    "wifi": true,
    "thermal": true,
    "audio": true,
    "network": true,
    "ttlMs": 60000
  },
  "wakeLock": { "mode": "off" },
  "jobScheduler": { "enabled": false, "periodMs": 900000 },
  "channels": {
    "critical": "waywiser-critical",
    "proactive": "waywiser-proactive",
    "multitask": "waywiser-multitask",
    "approval": "waywiser-approval"
  },
  "biometric": { "gateAskUser": false },
  "capture": { "board": "default", "type": "task" },
  "actions": { "defaultTTLMs": 3600000 }
}
```

## 12. Security posture

1. **Every action string is fixed-shape.** The variable slot is a token
   (hex UUID); no user data is interpolated.
2. **`$REPLY` is env-expanded**, then received by `waywiser-reply` as
   argv[2] (double-quoted). Never eval'd, never re-parsed.
3. **Inbox tokens expire** (`actions.defaultTTLMs`, default 1 h).
4. **Inbox files are one-shot**: consuming a token deletes the file.
5. **Biometric failure = deny.** Missing termux-fingerprint = deny.
6. **Widget scripts never contain secrets** — they call installed
   binaries only.

## 13. Testing

- `test/mobile/actions.test.ts` — argv builder + shell-escape assertions;
  fuzz `$REPLY`-adjacent strings.
- `test/mobile/inbox.test.ts` — token issue/redeem, TTL expiry, one-shot
  semantics, race safety.
- `test/mobile/context.test.ts` — parser robustness against malformed
  `termux-battery-status` output.
- `test/mobile/signals.test.ts` — battery/thermal/wifi discretion behavior.
- Smoke: `test/smoke.test.ts` already exercises the extension loader — the
  mobile extension must load without error on desktop (where all termux-*
  probes fail).

## 14. Out of scope (for this cut)

- Reading arbitrary Android notifications (`termux-notification-list`) —
  privacy sensitive; needs its own consent surface.
- SMS ingest — same.
- Live voice conversation — STT/TTS latency ruins the loop.
- Location tracking — foreground service + battery cost; the SSID proxy
  covers the interesting cases.

These are named so future work has a starting point, not deferred silently.
