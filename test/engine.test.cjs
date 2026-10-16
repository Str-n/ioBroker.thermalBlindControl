const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, defaults, roomDefaults, windowDefaults, normalizePosition, devicePosition } = require('../build/lib/config');
const { newGlobal, newWindow, restoreWindow, rollover, observe, beginCommand, decide, completeEvent, manualAction, dailyManualPositionLimit } = require('../build/lib/engine');
const { localDate, atLocal, nextMidnight, schedule, HOUR, MINUTE } = require('../build/lib/time');
const c = parseConfig({ ...defaults, enabled: true, dryRun: false, thermalMode: 'active', rooms: [{ ...roomDefaults, id: 'room', temperatureSensorId: 'room.temp' }],
    windows: [{ ...windowDefaults, id: 'south', roomId: 'room', positionStateId: 'blind.actual', positionCommandId: 'blind.target' }] });
const now = Date.parse('2026-07-15T12:00:00+02:00');
function fixture() {
    const global = newGlobal(c, now); global.modeChangedAt = now - 24 * HOUR;
    const runtime = newWindow(c.windows[0], c, now); runtime.participatingToday = true; runtime.actualPosition = 100;
    return { config: c, global, runtime, now, actualPosition: 100, thermalTarget: 0, forecastValid: true, roomValid: true, startupReady: true, directSun: true };
}
test('priority 1/2: global and daily disables prohibit every automatic command, including vacation', () => {
    const input = fixture(); input.global.vacationMode = true; input.now = schedule(now, c).evening + MINUTE;
    input.global.enabled = false; input.global.disabledToday = true;
    assert.equal(decide(input).reason, 'SYSTEM_DISABLED'); assert.equal(decide(input).target, null);
    input.global.enabled = true; assert.equal(decide(input).reason, 'DISABLED_TODAY');
    input.global.disabledToday = false; assert.equal(decide(input).target, 0);
});
test('vacation schedules override window flags but never a manual hold and require no forecast or room sensor', () => {
    const i = fixture(); i.global.vacationMode = true; i.runtime.enabled = false; i.runtime.autoMorningOpen = false; i.runtime.participatingToday = false;
    i.forecastValid = false; i.roomValid = false; i.now = schedule(now, c).evening;
    assert.equal(decide(i).reason, 'VACATION_CLOSE');
    i.runtime.manualHoldUntil = i.now + HOUR; assert.equal(decide(i).reason, 'MANUAL_LOCK');
    i.runtime.manualHoldUntil = 0; i.actualPosition = 0; i.now = schedule(now, c).morning;
    assert.equal(decide(i).reason, 'VACATION_OPEN'); assert.equal(decide(i).target, 100);
});
test('vacation keeps daytime thermal protection active without morning opt-in or normal daily participation', () => {
    const i = fixture(); i.global.vacationMode = true;
    i.runtime.enabled = false; i.runtime.autoMorningOpen = false; i.runtime.participatingToday = false;
    i.thermalTarget = 50;
    assert.equal(decide(i).target, 50); assert.equal(decide(i).reason, 'THERMAL_PROTECTION');
    assert.equal(decide(i).event, undefined);
    i.runtime.vacationMorningDate = localDate(now, c.timezone);
    assert.equal(decide(i).target, 50, 'protection must continue after the vacation morning routine');
    i.directSun = false; i.actualPosition = 50;
    assert.equal(decide(i).target, 100); assert.equal(decide(i).reason, 'NO_DIRECT_SUN');
    assert.equal(i.runtime.participatingToday, false, 'vacation must not acquire normal-mode enrollment');
    i.global.vacationMode = false; i.runtime.enabled = true;
    assert.equal(decide(i).reason, 'WAIT_FIRST_OPEN');
});
test('vacation daytime protection preserves manual preferences, daylight and movement limits', () => {
    const i = fixture(); i.global.vacationMode = true; i.runtime.autoMorningOpen = false; i.runtime.participatingToday = false;
    i.thermalTarget = 0; i.minimumThermalPosition = 20;
    assert.equal(decide(i).target, 20);
    i.runtime.manualHoldUntil = now + HOUR; assert.equal(decide(i).reason, 'MANUAL_LOCK');
    i.runtime.manualHoldUntil = 0; i.runtime.lastAutoAt = now - MINUTE;
    assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
    i.runtime.lastAutoAt = 0; i.actualPosition = 25;
    assert.equal(decide(i).target, null); assert.equal(decide(i).reason, 'NO_CHANGE');
    i.config = { ...c, respectManualPositionUntilEndOfDay: true };
    i.runtime.manualPositionLimit = 0; i.runtime.manualPositionLimitDate = localDate(now, c.timezone);
    i.actualPosition = 0; i.directSun = false;
    assert.equal(decide(i).target, null); assert.equal(decide(i).reason, 'MANUAL_POSITION_LIMIT');
});
test('vacation mornings use the thermal target immediately and retain independent schedule fallbacks', () => {
    const i = fixture(); i.global.vacationMode = true; i.runtime.autoMorningOpen = false; i.runtime.participatingToday = false;
    i.now = schedule(now, c).morning; i.actualPosition = 0; i.thermalTarget = 50;
    let decision = decide(i);
    assert.equal(decision.target, 50); assert.equal(decision.event, 'vacationMorning');
    completeEvent(i.runtime, decision.event, i.now, c);
    assert.equal(i.runtime.participatingToday, false);
    i.actualPosition = 50; i.thermalTarget = 25;
    assert.equal(decide(i).target, 25); assert.equal(decide(i).reason, 'THERMAL_PROTECTION');
    assert.equal(decide(i).event, undefined, 'the schedule must complete even when its opening was partial');
    i.runtime.vacationMorningDate = ''; i.actualPosition = 0;
    for (const patch of [{ forecastValid: false }, { roomValid: false }, { thermalTarget: null },
        { config: { ...c, thermalMode: 'off' } }, { config: { ...c, thermalMode: 'shadow' } }, { directSun: false }]) {
        decision = decide({ ...i, ...patch });
        assert.equal(decision.target, 100); assert.equal(decision.event, 'vacationMorning');
    }
    i.thermalTarget = 0;
    decision = decide(i); assert.equal(decision.target, null); assert.equal(decision.reason, 'NO_CHANGE');
    completeEvent(i.runtime, decision.event, i.now, c);
    assert.equal(i.runtime.vacationMorningDate, localDate(i.now, c.timezone));
});
test('vacation thermal protection holds positions outside daytime schedule hours', () => {
    const i = fixture(); i.global.vacationMode = true;
    const times = schedule(now, c);
    for (const time of [times.morning - MINUTE, times.evening + (c.scheduleCatchUpMinutes + 1) * MINUTE]) {
        i.now = time;
        assert.equal(decide(i).target, null); assert.equal(decide(i).reason, 'VACATION_WAIT');
    }
});
test('normal disabled windows and opted-out windows cannot participate before external daily opening', () => {
    const i = fixture(); i.runtime.enabled = false; assert.equal(decide(i).reason, 'WINDOW_DISABLED');
    i.runtime.enabled = true; i.runtime.autoMorningOpen = false; i.runtime.participatingToday = false;
    assert.equal(decide(i).reason, 'WAIT_FIRST_OPEN');
    i.runtime.actualPosition = 0;
    observe(i.runtime, { kind: 'actual', position: 80, ts: now }, c, now, 'own'); assert.equal(i.runtime.participatingToday, false);
    observe(i.runtime, { kind: 'actual', position: 90, ts: now + MINUTE }, c, now + MINUTE, 'own');
    assert.equal(i.runtime.participatingToday, true); assert.equal(i.runtime.manualHoldUntil, now + 61 * MINUTE);
    i.now = now + 61 * MINUTE; assert.equal(decide(i).target, 0);
});
test('manual hold is window-local, lasts 60 minutes and extends on every further move', () => {
    const a = fixture(), b = fixture(); a.runtime.actualPosition = 100;
    observe(a.runtime, { kind: 'actual', position: 75, ts: now }, c, now, 'own');
    assert.equal(decide(a).reason, 'MANUAL_LOCK'); assert.equal(decide(b).target, 0);
    observe(a.runtime, { kind: 'actual', position: 50, ts: now + 30 * MINUTE }, c, now + 30 * MINUTE, 'own');
    a.now = now + 89 * MINUTE; assert.equal(decide(a).target, null);
    a.now = now + 90 * MINUTE; assert.equal(decide(a).target, 0);
});
test('a manual 25% limit allows automatic 0%, caps a later 75% plan at 25%, and is replaced by manual 90%', () => {
    const i = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true };
    i.runtime.actualPosition = 50; i.runtime.lastPlannedPosition = 50;
    observe(i.runtime, { kind: 'actual', position: 25, ts: now }, i.config, now, 'own');
    assert.equal(i.runtime.manualPositionLimit, 25);
    i.actualPosition = 25; i.thermalTarget = 75;
    assert.equal(decide(i).reason, 'MANUAL_LOCK');
    i.now += HOUR; i.thermalTarget = 0;
    assert.equal(decide(i).target, 0);
    beginCommand(i.runtime, c.windows[0], 0, 'THERMAL_PROTECTION', i.now, 'shade-further');
    observe(i.runtime, { kind: 'actual', position: 0, ts: i.now + 10000 }, i.config, i.now + 10000, 'own');
    assert.equal(i.runtime.manualPositionLimit, 25, 'automatic closing must not overwrite the user limit');
    i.now += 15 * MINUTE; i.actualPosition = 0; i.thermalTarget = 75;
    assert.equal(decide(i).target, 25); assert.equal(decide(i).reason, 'MANUAL_POSITION_LIMIT');
    observe(i.runtime, { kind: 'actual', position: 90, ts: i.now }, i.config, i.now, 'own');
    assert.equal(i.runtime.manualPositionLimit, 90);
    i.actualPosition = 90; i.thermalTarget = 100; i.now += HOUR;
    assert.equal(decide(i).target, null); assert.equal(decide(i).calculatedPosition, 90);
    i.thermalTarget = 75; assert.equal(decide(i).target, 75);
});
test('manual fully closing to 0 stays closed even without a plan and overrides daylight and unlit reopening', () => {
    const i = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true };
    for (const planned of [null, 0, 50]) {
        i.runtime = newWindow(c.windows[0], i.config, now); i.runtime.participatingToday = true;
        i.runtime.actualPosition = 100; i.runtime.lastPlannedPosition = planned;
        observe(i.runtime, { kind: 'actual', position: 0, ts: now }, i.config, now, 'own');
        i.actualPosition = 0; i.thermalTarget = 75; i.minimumThermalPosition = 30; i.now = now + HOUR;
        for (const sun of [true, false]) {
            i.directSun = sun; assert.equal(decide(i).target, null);
            assert.equal(decide(i).calculatedPosition, 0); assert.equal(decide(i).reason, 'MANUAL_POSITION_LIMIT');
        }
    }
});
test('the optional limit starts only below the plan and remains window-local; later manual moves replace it', () => {
    const i = fixture(), other = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true };
    i.runtime.lastPlannedPosition = 50;
    manualAction(i.runtime, 75, now, i.config); assert.equal(i.runtime.manualPositionLimit, null);
    manualAction(i.runtime, 50, now, i.config); assert.equal(i.runtime.manualPositionLimit, null);
    manualAction(i.runtime, 25, now, i.config); assert.equal(i.runtime.manualPositionLimit, 25);
    assert.equal(other.runtime.manualPositionLimit, null);
    manualAction(i.runtime, 100, now, i.config); assert.equal(i.runtime.manualPositionLimit, 100);
    manualAction(i.runtime, 80, now, i.config); assert.equal(i.runtime.manualPositionLimit, 80);
    manualAction(i.runtime, 0, now, c); assert.equal(dailyManualPositionLimit(i.runtime, c, now), null);
    assert.equal(i.runtime.manualPositionLimit, null, 'manual operation while disabled clears an earlier preference');
});
test('confirmed manual feedback sets the limit while own echoes and periodic snapshots do not create or extend it', () => {
    const i = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true }; i.runtime.lastPlannedPosition = 100;
    observe(i.runtime, { kind: 'actual', position: 100, ts: now }, i.config, now, 'own');
    assert.equal(i.runtime.manualPositionLimit, null);
    observe(i.runtime, { kind: 'target', position: 0, ack: false, from: 'user', ts: now }, i.config, now, 'own');
    assert.equal(i.runtime.manualPositionLimit, null, 'a requested target alone is not a confirmed manual position');
    for (const position of [75, 25, 0]) observe(i.runtime, { kind: 'actual', position, ts: now + 1000 }, i.config, now + 1000, 'own');
    assert.equal(i.runtime.manualPositionLimit, 0);
    const until = i.runtime.manualHoldUntil;
    observe(i.runtime, { kind: 'actual', position: 0, ts: now + MINUTE }, i.config, now + MINUTE, 'own');
    assert.equal(i.runtime.manualHoldUntil, until);
    observe(i.runtime, { kind: 'target', position: 1, ack: false, from: 'user', ts: now + MINUTE }, i.config, now + MINUTE, 'own');
    observe(i.runtime, { kind: 'actual', position: 1, ts: now + MINUTE + 1000 }, i.config, now + MINUTE + 1000, 'own');
    assert.equal(i.runtime.manualPositionLimit, 1, 'small acknowledged manual requests still replace the daily limit');
    i.runtime.manualPositionLimit = 25; i.runtime.actualPosition = 0; i.runtime.observationAnchor = 0;
    observe(i.runtime, { kind: 'target', position: 90, ack: false, from: 'user', ts: now + 2 * MINUTE }, i.config, now + 2 * MINUTE, 'own');
    observe(i.runtime, { kind: 'actual', position: 0, ts: now + 2 * MINUTE + 1000 }, i.config, now + 2 * MINUTE + 1000, 'own');
    assert.equal(i.runtime.manualPositionLimit, 25, 'unchanged feedback while a manual opening is pending must not tighten the earlier preference');
});
test('daily limits survive restart, expire at local midnight on DST days, and do not block next-day morning opening', () => {
    const config = { ...c, respectManualPositionUntilEndOfDay: true };
    for (const date of ['2026-03-29', '2026-10-25']) {
        const start = atLocal(date, '15:00', c.timezone), midnight = nextMidnight(start, c.timezone);
        const runtime = newWindow(c.windows[0], config, start); runtime.actualPosition = 100;
        manualAction(runtime, 0, start, config);
        const restored = restoreWindow(JSON.parse(JSON.stringify(runtime)), c.windows[0], config, start + MINUTE);
        assert.equal(dailyManualPositionLimit(restored, config, midnight - 1), 0);
        assert.equal(dailyManualPositionLimit(restored, config, midnight), null);
        const global = newGlobal(config, start);
        rollover(global, [restored], midnight, config); assert.equal(restored.manualPositionLimit, null);
        const morning = schedule(midnight, config).morning;
        assert.equal(decide({ ...fixture(), config, global, runtime: restored, now: morning, actualPosition: 0 }).target, 100);
    }
});
test('a manual closing just after midnight survives the global daily rollover, and yesterday feedback cannot relatch it', () => {
    const config = { ...c, respectManualPositionUntilEndOfDay: true }, midnight = nextMidnight(now, c.timezone);
    const r = fixture().runtime, global = newGlobal(config, now);
    observe(r, { kind: 'actual', position: 0, ts: midnight + 1000 }, config, midnight + 1000, 'own');
    rollover(global, [r], midnight + 1000, config);
    assert.equal(dailyManualPositionLimit(r, config, midnight + 1000), 0);
    const old = fixture().runtime; old.lastPlannedPosition = 100;
    observe(old, { kind: 'actual', position: 25, ts: midnight - 1000 }, config, midnight + 1000, 'own');
    assert.equal(dailyManualPositionLimit(old, config, midnight + 1000), null);
});
test('daily manual limits also constrain scheduled openings, respect movement guards and clear when the option is disabled', () => {
    for (const vacation of [false, true]) {
        const i = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true };
        i.global.vacationMode = vacation; i.runtime.participatingToday = false;
        i.thermalTarget = 100;
        i.now = schedule(now, c).morning; i.actualPosition = 0;
        i.runtime.manualPositionLimit = 25; i.runtime.manualPositionLimitDate = localDate(i.now, c.timezone);
        assert.equal(decide(i).target, 25); assert.equal(decide(i).reason, 'MANUAL_POSITION_LIMIT');
        i.runtime.lastAutoAt = i.now - MINUTE;
        assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
        const restored = restoreWindow(JSON.parse(JSON.stringify(i.runtime)), c.windows[0], c, i.now);
        assert.equal(restored.manualPositionLimit, null);
        i.runtime = restored; i.runtime.lastAutoAt = 0; i.config = c;
        assert.equal(decide(i).target, 100, 'the disabled option must restore ordinary schedule opening');
    }
});
test('own target echoes, monotone intermediate positions and duplicate completion do not create holds', () => {
    const i = fixture(), r = i.runtime;
    beginCommand(r, c.windows[0], 0, 'THERMAL_PROTECTION', now, 'cmd-1');
    assert.equal(observe(r, { kind: 'target', position: 0, ts: now, ack: false, from: 'own' }, c, now, 'own'), 'own');
    for (const [offset, position] of [[10, 80], [20, 40], [30, 0], [40, 0]]) {
        assert.equal(observe(r, { kind: 'actual', position, ts: now + offset * 1000, ack: true, from: 'device' }, c, now + offset * 1000, 'own'), 'own');
    }
    assert.equal(r.manualHoldUntil, 0); assert.equal(r.ownCommand.completed, true);
});
test('external same-target request, reversal, unexplained moving and late feedback are manual', () => {
    for (const event of [
        { kind: 'target', position: 0, ts: now + 1000, ack: false, from: 'user' },
        { kind: 'actual', position: 80, ts: now + 30000 },
        { kind: 'actual', position: 0, ts: now + 180000 },
    ]) {
        const r = fixture().runtime; beginCommand(r, c.windows[0], 0, 'TEST', now, 'cmd');
        if (event.position === 80) { r.actualPosition = 40; r.ownCommand.lastFeedback = 40; }
        assert.equal(observe(r, event, c, event.ts, 'own'), 'manual'); assert(r.manualHoldUntil > event.ts);
    }
    const r = fixture().runtime; assert.equal(observe(r, { kind: 'moving', moving: true, ts: now }, c, now, 'own'), 'manual');
});
test('runtime survives restart; old days reset participation but keep holds and command identity', () => {
    const i = fixture(); i.runtime.manualHoldUntil = now + HOUR;
    beginCommand(i.runtime, c.windows[0], 0, 'TEST', now, 'saved');
    const restored = restoreWindow(JSON.parse(JSON.stringify(i.runtime)), c.windows[0], c, now + MINUTE);
    assert.equal(restored.manualHoldUntil, now + HOUR); assert.equal(restored.ownCommand.id, 'saved');
    rollover(i.global, [restored], now + 24 * HOUR, c);
    assert.equal(restored.participatingToday, false); assert.equal(restored.manualHoldUntil, now + HOUR);
    assert.equal(restored.ownCommand.id, 'saved');
});
test('legacy percent-closed runtime migrates once while retaining command progress, holds and cooldown', () => {
    const legacy = fixture().runtime; delete legacy.positionConvention;
    legacy.actualPosition = 25; legacy.observationAnchor = 24;
    legacy.manualHoldUntil = now + HOUR; legacy.lastAutoAt = now;
    legacy.ownCommand = { id: 'legacy-command', target: 100, startPosition: 0, lastFeedback: 25,
        issuedAt: now, expiresAt: now + 2 * MINUTE, completed: false, reason: 'THERMAL_PROTECTION' };
    const migrated = restoreWindow(legacy, c.windows[0], c, now + MINUTE);
    assert.equal(migrated.positionConvention, 'percentOpen');
    assert.equal(migrated.actualPosition, 75); assert.equal(migrated.observationAnchor, 76);
    assert.deepEqual(migrated.ownCommand, { ...legacy.ownCommand, target: 0, startPosition: 100, lastFeedback: 75 });
    assert.equal(migrated.manualHoldUntil, now + HOUR); assert.equal(migrated.lastAutoAt, now);
    const restored = restoreWindow(JSON.parse(JSON.stringify(migrated)), c.windows[0], c, now + MINUTE);
    assert.deepEqual(restored, migrated, 'marked percent-open runtime must never be inverted again');
    assert.equal(observe(restored, { kind: 'actual', position: 50, ts: now + MINUTE }, c, now + MINUTE, 'own'), 'own');
    assert.equal(restored.manualHoldUntil, now + HOUR);
});
test('slow manual movement and small-step reversals cannot hide inside feedback tolerance', () => {
    const r = fixture().runtime; r.participatingToday = false; r.actualPosition = 0;
    for (let position = 1; position <= 90; position++) observe(r, { kind: 'actual', position, ts: now + position * 1000 }, c, now + position * 1000, 'own');
    assert(r.manualHoldUntil > now); assert(r.participatingToday);
    const own = fixture().runtime; beginCommand(own, c.windows[0], 0, 'TEST', now, 'cmd');
    observe(own, { kind: 'actual', position: 40, ts: now + 10000 }, c, now + 10000, 'own');
    for (let i = 1; i <= 4; i++) observe(own, { kind: 'actual', position: 40 + i, ts: now + 10000 + i * 1000 }, c, now + 10000 + i * 1000, 'own');
    assert(own.manualHoldUntil > now); assert.equal(own.ownCommand, null);
});
test('daily disable persists within the date and resets at local midnight without a command', () => {
    const i = fixture(); i.global.disabledToday = true; i.global.disabledDate = localDate(now, c.timezone);
    const restored = JSON.parse(JSON.stringify(i.global)); rollover(restored, [i.runtime], now + HOUR, c); assert(restored.disabledToday);
    i.now = nextMidnight(now, c.timezone); i.dayChanged = rollover(restored, [i.runtime], i.now, c); i.global = restored;
    assert.equal(restored.disabledToday, false); assert.equal(decide(i).reason, 'DAY_RESET');
});
test('normal morning opening occurs once, then thermal movement waits for cooldown', () => {
    const i = fixture(); i.runtime.participatingToday = false; i.actualPosition = 0; i.runtime.actualPosition = 0; i.now = schedule(now, c).morning;
    const d = decide(i); assert.equal(d.reason, 'MORNING_OPEN'); assert.equal(d.target, 100);
    beginCommand(i.runtime, c.windows[0], 100, d.reason, i.now, 'morning'); completeEvent(i.runtime, d.event, i.now, c);
    observe(i.runtime, { kind: 'actual', position: 100, ts: i.now + MINUTE, ack: true }, c, i.now + MINUTE, 'own');
    i.actualPosition = 100; i.now += 2 * MINUTE; assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
    i.now += 13 * MINUTE; assert.equal(decide(i).reason, 'THERMAL_PROTECTION');
    i.now = schedule(now, c).evening; assert.equal(decide(i).reason, 'OUTSIDE_CONTROL_HOURS');
});
test('vacation mode switches and expired events skip scheduled catch-up while daytime protection continues', () => {
    const i = fixture(); i.global.vacationMode = true; i.now = schedule(now, c).morning + MINUTE;
    i.global.modeChangedAt = i.now; i.thermalTarget = 50;
    assert.equal(decide(i).reason, 'THERMAL_PROTECTION'); assert.equal(decide(i).event, undefined);
    i.global.modeChangedAt = 0; i.now += 61 * MINUTE;
    assert.equal(decide(i).target, 50); assert.equal(decide(i).event, undefined);
});
test('execution rejects a stale shaded target when direct sunlight has ended', () => {
    const i = fixture(); i.directSun = false;
    assert.equal(decide(i).target, null); assert.equal(decide(i).calculatedPosition, 100);
    i.actualPosition = 50;
    assert.equal(decide(i).target, 100); assert.equal(decide(i).reason, 'NO_DIRECT_SUN');
    i.runtime.manualHoldUntil = now + HOUR; assert.equal(decide(i).reason, 'MANUAL_LOCK');
});
test('a 60-minute interval blocks opening and closing until exactly one hour, including after runtime restoration', () => {
    for (const [position, target] of [[100, 50], [50, 100]]) {
        const i = fixture(); i.config = { ...c, minMovementIntervalMinutes: 60 };
        i.actualPosition = position; i.thermalTarget = target; i.runtime.lastAutoAt = now;
        i.runtime = restoreWindow(JSON.parse(JSON.stringify(i.runtime)), c.windows[0], i.config, now + 30 * MINUTE);
        i.now = now + 59 * MINUTE; assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
        i.now = now + HOUR; assert.equal(decide(i).target, target);
    }
});
test('the daylight floor caps stale targets while respecting the position threshold and movement interval', () => {
    const i = fixture(); i.minimumThermalPosition = 2; i.actualPosition = 0; i.thermalTarget = 0;
    assert.equal(decide(i).target, null); assert.equal(decide(i).reason, 'NO_CHANGE');
    assert.equal(decide(i).calculatedPosition, 2);
    i.minimumThermalPosition = 12;
    assert.equal(decide(i).target, 12); assert.equal(decide(i).reason, 'DAYLIGHT_MINIMUM');
    i.runtime.lastAutoAt = now; i.config = { ...c, minMovementIntervalMinutes: 60 };
    i.now = now + 59 * MINUTE; assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
    i.now = now + HOUR; assert.equal(decide(i).target, 12);
    i.runtime.manualHoldUntil = i.now + HOUR; assert.equal(decide(i).reason, 'MANUAL_LOCK');
});
test('automatic changes use an absolute configurable threshold, including the exact boundary in both directions', () => {
    assert.equal(c.minPositionChange, 10);
    for (const [position, target, expected] of [[49, 53, null], [30, 53, 53], [44, 53, null], [43, 53, 53],
        [53, 49, null], [53, 30, 30], [53, 44, null], [53, 43, 43]]) {
        const i = fixture(); i.actualPosition = position; i.thermalTarget = target;
        const snapshot = structuredClone(i.runtime);
        assert.equal(decide(i).target, expected, `${position} -> ${target}`);
        assert.deepEqual(i.runtime, snapshot, 'ignored requests must not record movement or restart cooldown');
    }
    const i = fixture(); i.actualPosition = 49; i.thermalTarget = 53;
    i.config = { ...c, minPositionChange: 4 }; assert.equal(decide(i).target, 53);
    i.config = { ...c, minPositionChange: 5 }; assert.equal(decide(i).target, null);
    i.config = { ...c, minPositionChange: 1 }; i.thermalTarget = 50;
    assert.equal(decide(i).target, 50, 'feedback tolerance must not block a change meeting the configured threshold');
});
test('near-open automatic targets snap to 100 before checking move size, with a strict configurable boundary', () => {
    for (const [threshold, planned, actual, calculated, target] of [
        [10, 91, 70, 100, 100], [10, 93, 89, 100, 100], [10, 91, 100, 100, null],
        [10, 91, 95, 100, null], [10, 90, 70, 90, 90], [5, 95, 70, 95, 95],
        [5, 96, 70, 100, 100], [9.5, 90.5, 70, 90.5, 90.5], [9.5, 90.6, 70, 100, 100],
    ]) {
        const i = fixture(); i.config = { ...c, minPositionChange: threshold };
        i.actualPosition = actual; i.thermalTarget = planned;
        const decision = decide(i);
        assert.equal(decision.calculatedPosition, calculated, `plan ${planned}, threshold ${threshold}`);
        assert.equal(decision.target, target, `actual ${actual}, plan ${planned}, threshold ${threshold}`);
    }
    const i = fixture(); i.actualPosition = 70; i.thermalTarget = 91;
    i.config = { ...c, minMovementIntervalMinutes: 60 }; i.runtime.lastAutoAt = now;
    i.now = now + 59 * MINUTE; assert.equal(decide(i).reason, 'MOVEMENT_COOLDOWN');
    i.now = now + HOUR; assert.equal(decide(i).target, 100);
});
test('near-open snapping never exceeds a remembered manual opening ceiling', () => {
    for (const ceiling of [0, 25, 90, 95]) {
        const i = fixture(); i.config = { ...c, respectManualPositionUntilEndOfDay: true };
        i.actualPosition = 0; i.thermalTarget = 91;
        i.runtime.manualPositionLimit = ceiling; i.runtime.manualPositionLimitDate = localDate(now, c.timezone);
        const decision = decide(i);
        assert.equal(decision.calculatedPosition, ceiling);
        assert.equal(decision.target, ceiling === 0 ? null : ceiling);
        assert.equal(decision.reason, 'MANUAL_POSITION_LIMIT');
    }
});
test('morning, vacation and no-direct-sun openings also obey the configured position threshold', () => {
    for (const mode of ['morning', 'vacationMorning', 'vacationEvening', 'noSun']) {
        const i = fixture(), closing = mode === 'vacationEvening';
        i.actualPosition = closing ? 4 : 96;
        if (mode === 'noSun') i.directSun = false;
        else {
            i.global.vacationMode = mode !== 'morning'; i.runtime.participatingToday = false;
            i.thermalTarget = 100;
            i.now = schedule(now, c)[closing ? 'evening' : 'morning'];
        }
        assert.equal(decide(i).target, null, mode);
        assert.equal(decide(i).reason, 'NO_CHANGE', mode);
        i.actualPosition = closing ? 10 : 90;
        assert.equal(decide(i).target, closing ? 0 : 100, `${mode} at exact threshold`);
    }
});
test('invalid forecasts, positions, sensors, dry-run, shadow mode and startup block thermal movement', () => {
    for (const vacation of [false, true]) {
        for (const [key, value, reason] of [['forecastValid', false, 'FORECAST_INVALID'], ['roomValid', false, 'ROOM_INVALID'], ['actualPosition', null, 'POSITION_INVALID'], ['startupReady', false, 'STARTUP_DELAY'], ['thermalTarget', null, 'MODEL_UNAVAILABLE']]) {
            const i = fixture(); i.global.vacationMode = vacation;
            i[key] = value; assert.equal(decide(i).reason, reason); assert.equal(decide(i).target, null);
        }
        const i = fixture(); i.global.vacationMode = vacation;
        i.global.dryRun = true; assert.equal(decide(i).reason, 'DRY_RUN');
        i.global.dryRun = false; i.config = { ...c, thermalMode: 'shadow' }; assert.equal(decide(i).reason, 'SHADOW_MODE');
        i.config = { ...c, thermalMode: 'off' }; assert.equal(decide(i).reason, 'THERMAL_OFF');
    }
});
test('DST days have 23/25 hours while local scheduling is independent of host timezone', () => {
    for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
        const start = atLocal(date, '00:00', c.timezone);
        assert.equal((nextMidnight(start, c.timezone) - start) / HOUR, hours);
        assert.equal(localDate(start, c.timezone), date);
        const morning = atLocal(date, '07:00', c.timezone);
        assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, hour: '2-digit' }).format(morning), '07');
    }
});
test('configuration validates geometry, polarity, state uniqueness and forbids writing heating inputs', () => {
    for (const patch of [{ windows: [{ ...c.windows[0], deviceClosedValue: 100 }] }, { rooms: [{ ...c.rooms[0], heatLossWK: 0 }] },
        { windows: [{ ...c.windows[0], positionCommandId: 'room.temp' }] }, { windows: [c.windows[0], { ...c.windows[0], id: 'duplicate' }] },
        { manualOverrideMinutes: 30 }, { timezone: 'Invalid/Timezone' }, { windows: [{ ...c.windows[0], tiltDeg: 45 }] }]) assert.throws(() => parseConfig({ ...c, ...patch }));
    for (const [open, closed] of [[0, 100], [100, 0], [0, 1], [255, 0], [-1, 1]]) {
        const w = { ...c.windows[0], deviceOpenValue: open, deviceClosedValue: closed };
        assert.equal(normalizePosition(open, w), 100); assert.equal(normalizePosition(closed, w), 0);
        assert.equal(normalizePosition(devicePosition(25, w), w), 25); assert.equal(normalizePosition(null, w), null);
    }
    const legacy = { ...c.windows[0], openIsPercent: 0 }; delete legacy.deviceOpenValue; delete legacy.deviceClosedValue;
    assert.equal(parseConfig({ ...c, windows: [legacy] }).windows[0].deviceOpenValue, 0);
});
