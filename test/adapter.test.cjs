const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { parseConfig, defaults, roomDefaults, windowDefaults, devicePosition } = require('../build/lib/config');
const { newWindow, newGlobal } = require('../build/lib/engine');
const { syntheticForecast } = require('../build/lib/simulator');
const { MINUTE, HOUR, localDate, nextMidnight, schedule } = require('../build/lib/time');
const fixedNow = Date.parse('2026-07-15T12:00:00+02:00');
let clock = fixedNow;
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });
class MockAdapter extends EventEmitter {
    constructor(options) {
        super(); this.namespace = 'thermalblindcontrol.0'; this.config = options.native; this.states = options.states || new Map();
        this.foreign = options.foreign || new Map(); this.objects = new Map(); this.commands = []; this.subscriptions = new Set(); this.logs = [];
        this.instanceObject = { _id: `system.adapter.${this.namespace}`, type: 'instance', common: { name: 'thermalblindcontrol' }, native: structuredClone(options.native) };
        this.configWrites = [];
        this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
    }
    async setObjectNotExistsAsync(id, obj) { if (!this.objects.has(id)) this.objects.set(id, obj); }
    async getStateAsync(id) { return this.states.get(id) || null; }
    async setStateAsync(id, val, ack) { this.states.set(id, { val, ack, ts: Date.now() }); if (this.writeHook) await this.writeHook(id, val); }
    async setStateChangedAsync(...args) { await this.setStateAsync(...args); }
    async subscribeStatesAsync() {}
    async subscribeForeignStatesAsync(id) { this.subscriptions.add(id); }
    async getForeignStateAsync(id) { return this.foreign.get(id) || null; }
    async getForeignObjectAsync(id) { assert.equal(id, this.instanceObject._id); return structuredClone(this.instanceObject); }
    async setForeignObjectAsync(id, obj) {
        assert.equal(id, this.instanceObject._id);
        this.instanceObject = structuredClone(obj); this.configWrites.push(structuredClone(obj));
    }
    async setForeignStateAsync(id, val, ack) {
        const window = this.config.windows.find(w => w.positionCommandId === id);
        assert(window, 'only configured blind actuators can be written');
        const runtime = JSON.parse(this.states.get(`windows.${window.id}.runtime`).val);
        assert(runtime.lastAutoAt > 0, 'cooldown must be durable before command'); assert(runtime.ownCommand?.id, 'identity must be durable before command');
        this.commands.push({ id, val, ack }); if (this.failCommand) throw new Error('simulated delivery failure');
        if (this.commandHook) await this.commandHook(id, val, ack);
    }
}
const originalLoad = Module._load;
Module._load = function (id, ...rest) { return id === '@iobroker/adapter-core' ? { Adapter: MockAdapter } : originalLoad.call(this, id, ...rest); };
const create = require('../build/main');
Module._load = originalLoad;
function baseConfig(overrides = {}) {
    return parseConfig({ ...defaults, enabled: true, dryRun: false, thermalMode: 'active', startupDelaySeconds: 3600,
        rooms: [{ ...roomDefaults, id: 'room', temperatureSensorId: 'room.temp' }],
        windows: [{ ...windowDefaults, id: 'south', roomId: 'room', positionStateId: 'blind.actual', positionCommandId: 'blind.target' }], ...overrides });
}
async function fixture(t, options = {}) {
    clock = options.now || fixedNow;
    const c = baseConfig(options.native), states = options.states || new Map();
    const state = val => ({ val, ts: clock, ack: true });
    if (!options.states) {
        for (const w of c.windows) { const r = newWindow(w, c, clock); r.participatingToday = options.participating ?? true; r.actualPosition = options.initialPosition ?? 100; states.set(`windows.${w.id}.runtime`, state(JSON.stringify(r))); }
        const g = newGlobal(c, clock); g.modeChangedAt = clock - 24 * HOUR; states.set('global.runtime', state(JSON.stringify(g)));
    }
    const foreign = new Map([...c.rooms.map(r => [r.temperatureSensorId, state(27)]), ...c.windows.map(w => [w.positionStateId, state(devicePosition(options.initialPosition ?? 100, w))])]);
    for (const [id, sample] of options.foreign || []) foreign.set(id, sample);
    const a = create({ native: options.rawNative || c, states, foreign });
    a.refreshForecast = async () => {};
    t.after(() => new Promise(resolve => a.emit('unload', resolve)));
    await a.ready();
    assert.equal(a.logs.filter(l => l.level === 'error').length, 0, JSON.stringify(a.logs));
    a.forecast = syntheticForecast(clock, c, 31, 3, 0); a.dirty = true;
    return a;
}
async function matchingWindowFixture(t, shared = false, reverse = false, initialPosition = 100) {
    const ids = ['eg_esszimmer', 'eg_wohnzimmer2', 'eg_wohnzimmer1'];
    const windows = (reverse ? [...ids].reverse() : ids).map(id => ({ ...windowDefaults, id, roomId: 'room',
        glassAreaM2: 2, gValue: 0.5, closedTransmission: 0,
        positionStateId: `${id}.actual`, positionCommandId: `${id}.${shared ? 'actual' : 'target'}`, movementStateId: `${id}.moving` }));
    const now = Date.parse('2026-07-15T10:00:00+02:00');
    const a = await fixture(t, { now, initialPosition, native: { rooms: [{ ...roomDefaults, id: 'room', temperatureSensorId: 'room.temp', heatLossWK: 100 }], windows, toleranceMaxC: 0 },
        foreign: new Map([['room.temp', { val: 21, ts: now, ack: true }]]) });
    a.startedAt -= 2 * HOUR;
    a.forecast = { fetchedAt: now, intervals: Array.from({ length: 100 }, (_, i) => ({
        start: now + i * 15 * MINUTE, end: now + (i + 1) * 15 * MINUTE,
        outsideC: 16, dni: i < 24 ? 1200 : 0, gti: { '180': i < 24 ? 1000 : 0 },
    })) };
    a.controls.dryRun = true; await a.evaluate();
    const targets = a.results.get('room').targets;
    assert.equal(new Set(Object.values(targets)).size, 1);
    assert(targets[ids[0]] > 0 && targets[ids[0]] < 90, 'test requires a shared partial-shading plan');
    a.controls.dryRun = false;
    return { a, target: targets[ids[0]] };
}
test('matching blinds keep the shared room target through opening/closing feedback in either order', async t => {
    for (const initial of [0, 100]) for (const shared of [false, true]) for (const reverse of [false, true]) {
        const { a, target } = await matchingWindowFixture(t, shared, reverse, initial);
        const halfway = Math.round((initial + target) / 2);
        a.commandHook = async (id, val) => {
            const w = a.settings.windows.find(w => w.positionCommandId === id);
            a.emit('stateChange', id, { val, ack: false, ts: clock, from: 'system.adapter.thermalblindcontrol.0' });
            if (!shared) a.emit('stateChange', id, { val, ack: true, ts: clock, from: 'system.adapter.motor.0' });
            a.emit('stateChange', w.movementStateId, { val: true, ack: true, ts: clock, from: 'system.adapter.motor.0' });
            a.emit('stateChange', w.positionStateId, { val: halfway, ack: true, ts: clock, from: 'system.adapter.motor.0' });
            a.emit('stateChange', w.movementStateId, { val: false, ack: true, ts: clock, from: 'system.adapter.motor.0' });
        };
        a.enqueue(() => a.evaluate()); await a.queue; await a.queue;
        assert.equal(a.commands.length, 3, `initial=${initial}, shared=${shared}, reverse=${reverse}`);
        assert(a.commands.every(command => command.val === target));
        await a.evaluate();
        assert.equal(a.commands.length, 3, 'travel/cooldown must prevent duplicate motor writes');
        const firstStep = a.results.get('room').plan[0].positions;
        for (const w of a.settings.windows) {
            assert.equal(a.states.get(`windows.${w.id}.actualPosition`).val, halfway, 'actual diagnostics must retain real feedback');
            assert.equal(firstStep[w.id], target, 'forecast must use the committed target while travel is underway');
            assert.equal(a.windows.get(w.id).manualHoldUntil, 0);
            a.emit('stateChange', w.positionStateId, { val: target, ack: true, ts: clock, from: 'system.adapter.motor.0' });
            a.emit('stateChange', w.movementStateId, { val: false, ack: true, ts: clock, from: 'system.adapter.motor.0' });
        }
        await a.queue;
        assert([...a.windows.values()].every(r => r.ownCommand.completed && r.manualHoldUntil === 0));
    }
});
test('shared own target echo retains confirmed feedback until the motor reports its new position', async t => {
    const { a, target } = await matchingWindowFixture(t, true);
    a.enqueue(() => a.evaluate()); await a.queue;
    const w = a.settings.windows[0];
    a.emit('stateChange', w.positionCommandId, { val: target, ack: false, ts: clock, from: 'system.adapter.thermalblindcontrol.0' });
    await a.queue; await a.evaluate();
    assert.equal(a.states.get(`windows.${w.id}.actualPosition`).val, 100);
    assert.equal(a.results.get('room').plan[0].positions[w.id], target);
    assert.equal(a.commands.length, 3);
});
test('pending room targets survive restart and stop being assumed after the travel timeout', async t => {
    const { a, target } = await matchingWindowFixture(t);
    await a.evaluate(); assert.equal(a.commands.length, 3);
    const b = await fixture(t, { now: clock, native: a.settings, states: a.states,
        foreign: new Map([['room.temp', { val: 21, ts: clock, ack: true }]]) });
    b.forecast = structuredClone(a.forecast); b.startedAt -= 2 * HOUR;
    await b.evaluate();
    assert.equal(b.commands.length, 0);
    assert(Object.values(b.results.get('room').plan[0].positions).every(position => position === target));
    clock += 2 * MINUTE + 1; await b.evaluate();
    assert(Object.values(b.results.get('room').plan[0].positions).every(position => position === 100), 'expired commands must use observed positions again');
});
test('manual writes, reversals and changed inputs still cancel the remaining room commands', async t => {
    for (const change of ['manualTarget', 'reversal', 'temperature', 'disable', 'badQuality']) {
        const { a, target } = await matchingWindowFixture(t);
        a.commandHook = async id => {
            if (a.commands.length !== 1) return;
            const w = a.settings.windows.find(w => w.positionCommandId === id);
            a.emit('stateChange', id, { val: target, ack: false, ts: clock, from: 'system.adapter.thermalblindcontrol.0' });
            if (change === 'manualTarget') a.emit('stateChange', id, { val: target, ack: false, ts: clock, from: 'system.adapter.admin.0' });
            if (change === 'reversal') for (const val of [90, 60, 80]) {
                a.emit('stateChange', w.positionStateId, { val, ack: true, ts: clock, from: 'system.adapter.motor.0' });
            }
            if (change === 'temperature') a.emit('stateChange', 'room.temp', { val: 25, ack: true, ts: clock });
            if (change === 'disable') a.emit('stateChange', 'thermalblindcontrol.0.global.enabled', { val: false, ack: false, ts: clock });
            if (change === 'badQuality') a.emit('stateChange', w.positionStateId, { val: 60, ack: true, ts: clock, q: 64 });
        };
        a.enqueue(() => a.evaluate()); await a.queue; await a.queue;
        assert.equal(a.commands.length, 1, change);
        for (const w of a.settings.windows.slice(1)) assert.equal(a.states.get(`windows.${w.id}.controlReason`).val, 'INPUT_CHANGED', change);
        if (change === 'manualTarget' || change === 'reversal') assert.equal(a.windows.get(a.settings.windows[0].id).manualHoldUntil, clock + HOUR, change);
    }
});
test('startup creates persistent writable controls, subscribes inputs and delays every motor command', async t => {
    const a = await fixture(t); await a.evaluate();
    assert.equal(a.commands.length, 0); assert.equal(a.states.get('windows.south.controlReason').val, 'STARTUP_DELAY');
    assert(a.objects.get('global.enabled').common.write); assert(!a.objects.get('windows.south.runtime').common.write);
    assert(a.subscriptions.has('blind.actual')); assert(a.subscriptions.has('room.temp'));
});
test('startup persists legacy GUI heating edits once and restores clean settings on restart', async t => {
    const native = baseConfig();
    native.rooms[0].heating = { ...native.rooms[0].heating, type: 'underfloor', nominalPowerW: 1500 };
    native.rooms[0]['heating.nominalPowerW'] = 150;
    native.rooms[0]['heating.setpointId'] = 'heating.setpoint';
    native['centralHeating.flowTemperatureId'] = 'heating.flow';
    native.extraSetting = 'preserved';
    const a = await fixture(t, { rawNative: native });
    assert.equal(a.settings.rooms[0].heating.nominalPowerW, 150);
    assert(a.subscriptions.has('heating.setpoint')); assert(a.subscriptions.has('heating.flow'));
    assert.equal(a.configWrites.length, 1); assert.equal(a.commands.length, 0);
    const saved = a.instanceObject.native;
    assert.equal(saved.rooms[0].heating.nominalPowerW, 150);
    assert.equal(saved.rooms[0].heating.setpointId, 'heating.setpoint');
    assert(!Object.hasOwn(saved.rooms[0], 'heating.nominalPowerW'));
    assert(!Object.hasOwn(saved.rooms[0], 'heating.setpointId'));
    assert(!Object.hasOwn(saved, 'centralHeating.flowTemperatureId'));
    assert.equal(saved.extraSetting, 'preserved');
    assert.deepEqual(a.instanceObject.common, { name: 'thermalblindcontrol' });
    const restarted = await fixture(t, { native: saved, rawNative: saved, states: a.states });
    assert.equal(restarted.configWrites.length, 0);
    assert.equal(restarted.settings.rooms[0].heating.nominalPowerW, 150);
});
test('startup migrates legacy runtime before comparing hardware feedback and persists the new convention', async t => {
    const c = baseConfig(), legacy = newWindow(c.windows[0], c, fixedNow);
    delete legacy.positionConvention;
    legacy.actualPosition = 0; legacy.observationAnchor = 0; legacy.lastAutoAt = fixedNow;
    legacy.ownCommand = { id: 'legacy-closing', target: 100, startPosition: 0, lastFeedback: 0,
        issuedAt: fixedNow, expiresAt: fixedNow + 2 * MINUTE, completed: false, reason: 'THERMAL_PROTECTION' };
    const states = new Map([['windows.south.runtime', { val: JSON.stringify(legacy), ts: fixedNow, ack: true }]]);
    const a = await fixture(t, { states });
    const r = a.windows.get('south');
    assert.equal(r.actualPosition, 100); assert.equal(r.ownCommand.target, 0);
    assert.equal(r.ownCommand.startPosition, 100); assert.equal(r.manualHoldUntil, 0);
    assert.equal(r.lastAutoAt, fixedNow); assert.equal(a.commands.length, 0);
    assert.equal(JSON.parse(a.states.get('windows.south.runtime').val).positionConvention, 'percentOpen');
    clock += 30 * 1000;
    await a.stateChanged('blind.actual', { val: 0, ts: clock, ack: true, from: 'system.adapter.motor.0' });
    assert.equal(r.actualPosition, 0); assert.equal(r.ownCommand.completed, true); assert.equal(r.manualHoldUntil, 0);
});
test('active controller persists intent before device write, uses configured polarity, and never writes heating inputs', async t => {
    const c = baseConfig(); c.rooms[0].heating = { ...c.rooms[0].heating, type: 'radiator', demandId: 'heating.demand', valvePositionId: 'heating.valve' };
    c.windows[0].deviceOpenValue = 0; c.windows[0].deviceClosedValue = 1;
    const a = await fixture(t, { native: c }); a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.deepEqual(a.commands, [{ id: 'blind.target', val: 1, ack: false }]);
    assert(a.subscriptions.has('heating.demand')); assert(a.subscriptions.has('heating.valve'));
    assert.equal(a.states.get('windows.south.controlReason').val, 'THERMAL_PROTECTION');
    assert(a.states.get('rooms.room.climateBudget24h').val < 0);
});
test('dry run and shadow publish target and temperature plan without recording motor activity', async t => {
    for (const native of [{ dryRun: true }, { thermalMode: 'shadow' }]) {
        const a = await fixture(t, { native }); a.startedAt -= 2 * HOUR; await a.evaluate();
        assert.equal(a.commands.length, 0); assert.equal(a.windows.get('south').lastAutoAt, 0);
        assert.equal(a.states.get('windows.south.calculatedPosition').val, 0);
        assert(JSON.parse(a.states.get('rooms.room.temperaturePlan').val).length >= 96);
    }
});
test('manual target during awaited persistence cancels the stale automatic command', async t => {
    const a = await fixture(t); a.startedAt -= 2 * HOUR;
    let injected = false;
    a.writeHook = async (id, value) => {
        if (!injected && id === 'windows.south.runtime' && JSON.parse(value).ownCommand) {
            injected = true;
            a.emit('stateChange', 'blind.target', { val: 100, ack: false, ts: clock, from: 'system.adapter.admin.0' });
        }
    };
    a.enqueue(() => a.evaluate()); await a.queue; await a.queue;
    assert(injected); assert.equal(a.commands.length, 0); assert.equal(a.windows.get('south').manualHoldUntil, clock + HOUR);
    assert.equal(a.windows.get('south').lastAutoAt, 0);
});
test('global disable arriving during persistence cancels a pending motor command', async t => {
    const a = await fixture(t); a.startedAt -= 2 * HOUR;
    let injected = false; a.writeHook = async (id, value) => {
        if (!injected && id === 'windows.south.runtime' && JSON.parse(value).ownCommand) {
            injected = true; a.emit('stateChange', 'thermalblindcontrol.0.global.enabled', { val: false, ack: false, ts: clock });
        }
    };
    a.enqueue(() => a.evaluate()); await a.queue; await a.queue;
    assert.equal(a.commands.length, 0); assert.equal(a.controls.enabled, false);
});
test('own feedback is recognized and external movements persist a lock across restart', async t => {
    const a = await fixture(t); a.startedAt -= 2 * HOUR; await a.evaluate();
    for (const [offset, val] of [[10, 75], [20, 25], [30, 0]]) {
        clock = fixedNow + offset * 1000;
        await a.stateChanged('blind.actual', { val, ts: clock, ack: true, from: 'system.adapter.motor.0' });
    }
    assert.equal(a.windows.get('south').manualHoldUntil, 0);
    clock += MINUTE; await a.stateChanged('blind.actual', { val: 100, ts: clock, ack: true, from: 'system.adapter.motor.0' });
    const until = a.windows.get('south').manualHoldUntil; assert.equal(until, clock + HOUR);
    const restarted = await fixture(t, { now: clock, states: a.states, foreign: new Map([['blind.actual', { val: 100, ts: clock, ack: true }]]) });
    assert.equal(restarted.windows.get('south').manualHoldUntil, until);
    restarted.startedAt -= 2 * HOUR; await restarted.evaluate(); assert.equal(restarted.commands.length, 0);
});
test('daily disable, window preferences and overnight reset are durable', async t => {
    const a = await fixture(t);
    await a.stateChanged('thermalblindcontrol.0.global.disabledToday', { val: true, ack: false, ts: clock });
    await a.stateChanged('thermalblindcontrol.0.windows.south.enabled', { val: false, ack: false, ts: clock });
    const b = await fixture(t, { now: clock + HOUR, states: a.states });
    assert(b.controls.disabledToday); assert.equal(b.windows.get('south').enabled, false);
    clock = nextMidnight(clock, b.settings.timezone); await b.evaluate();
    assert.equal(b.controls.disabledToday, false); assert.equal(b.windows.get('south').participatingToday, false); assert.equal(b.commands.length, 0);
});
test('pending disabledToday write at restart uses the write date, including DST midnight', async t => {
    const c = baseConfig(), beforeMidnight = Date.parse('2026-10-25T23:59:00+01:00');
    const states = new Map([['global.disabledToday', { val: true, ack: false, ts: beforeMidnight }]]);
    const a = await fixture(t, { now: beforeMidnight, states }); assert(a.controls.disabledToday);
    assert.equal(a.controls.disabledDate, localDate(beforeMidnight, c.timezone));
    const b = await fixture(t, { now: beforeMidnight + 2 * MINUTE, states: a.states }); assert.equal(b.controls.disabledToday, false);
});
test('forecast failure clears stale thermal diagnostics but vacation schedules still execute', async t => {
    const a = await fixture(t); a.startedAt -= 2 * HOUR; a.controls.dryRun = true; await a.evaluate();
    assert(a.states.get('rooms.room.predictedMaxTemp').val > 21);
    a.forecast = null; await a.evaluate(); assert.equal(a.states.get('rooms.room.predictedMaxTemp').val, null);
    assert.equal(a.states.get('windows.south.controlReason').val, 'FORECAST_INVALID');
    a.controls.vacationMode = true; a.controls.dryRun = false; a.windows.get('south').enabled = false;
    clock = schedule(clock, a.settings).evening; await a.evaluate();
    assert.deepEqual(a.commands, [{ id: 'blind.target', val: 0, ack: false }]);
});
test('enabling vacation starts daytime heat protection despite disabled morning opening and no enrollment', async t => {
    const c = baseConfig({ minimumSolarPowerPerWindowW: 20 });
    c.windows[0].autoMorningOpen = false; c.windows[0].enabled = false;
    const a = await fixture(t, { native: c, participating: false }); a.startedAt -= 2 * HOUR;
    await a.evaluate(); assert.equal(a.commands.length, 0);
    await a.stateChanged('thermalblindcontrol.0.global.vacationMode', { val: true, ack: false, ts: clock });
    await a.evaluate();
    assert.equal(a.commands.length, 1);
    const command = a.windows.get('south').ownCommand;
    assert(command.target > 0 && command.target < 100);
    assert.equal(a.states.get('windows.south.controlReason').val, 'THERMAL_PROTECTION');
    assert.equal(JSON.parse(a.states.get('rooms.room.temperaturePlan').val)[0].positions.south, command.target);
    assert.equal(a.windows.get('south').vacationMorningDate, '', 'mode switch must not replay a past morning event');
    assert.equal(a.windows.get('south').participatingToday, false);
    assert.equal(a.states.get('windows.south.autoMorningOpen').val, false);
    assert.equal(a.states.get('windows.south.enabled').val, false);
    clock += MINUTE;
    await a.stateChanged('blind.actual', { val: command.target, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    assert.equal(a.windows.get('south').manualHoldUntil, 0, 'vacation thermal commands remain recognized as own moves');
    await a.stateChanged('thermalblindcontrol.0.global.vacationMode', { val: false, ack: false, ts: clock });
    await a.evaluate();
    assert.equal(a.commands.length, 1); assert.equal(a.states.get('windows.south.controlReason').val, 'WINDOW_DISABLED');
});
test('the vacation morning motor command already includes heat protection with morning opening disabled', async t => {
    const c = baseConfig({ vacationMode: true, minimumSolarPowerPerWindowW: 20, morningEarliest: '10:00', morningLatest: '10:00' });
    c.windows[0].autoMorningOpen = false; c.windows[0].enabled = false;
    const a = await fixture(t, { native: c, participating: false, now: Date.parse('2026-07-15T10:00:00+02:00') });
    a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.commands.length, 1);
    const target = a.windows.get('south').ownCommand.target;
    assert(target > 0 && target < 100, 'the morning routine must not commit to fully open for an entire cooldown');
    assert.equal(a.states.get('windows.south.controlReason').val, 'VACATION_OPEN');
    assert.equal(a.windows.get('south').vacationMorningDate, localDate(clock, c.timezone));
    assert.equal(a.windows.get('south').participatingToday, false);
});
test('bad quality / missing / stale room and motor feedback never trigger thermal commands', async t => {
    for (const [id, sample] of [['room.temp', { val: 27, q: 1, ts: fixedNow }], ['blind.actual', { val: null, ts: fixedNow }], ['room.temp', { val: 27, ts: fixedNow - 181 * MINUTE }]]) {
        const a = await fixture(t, { foreign: new Map([[id, sample]]) }); a.startedAt -= 2 * HOUR; await a.evaluate();
        assert.equal(a.commands.length, 0); assert.equal(a.states.get('rooms.room.predictedMaxTemp').val, null);
    }
});
test('failed delivery retains cooldown and reports failure instead of repeatedly driving', async t => {
    const a = await fixture(t); a.startedAt -= 2 * HOUR; a.failCommand = true; await a.evaluate();
    assert.equal(a.commands.length, 1); assert.equal(a.states.get('windows.south.controlReason').val, 'COMMAND_FAILED');
    assert.equal(a.windows.get('south').lastAutoAt, clock); assert(a.windows.get('south').ownCommand);
    await a.evaluate(); assert.equal(a.commands.length, 1);
});
test('shared target/actual state detects external unacknowledged command and acknowledges own controls', async t => {
    const c = baseConfig(); c.windows[0].positionCommandId = 'blind.actual';
    const a = await fixture(t, { native: c }); a.startedAt -= 2 * HOUR;
    await a.stateChanged('blind.actual', { val: 0, ts: clock, ack: false, from: 'system.adapter.admin.0' });
    assert.equal(a.position('south', clock), 100, 'unacknowledged closed target must not replace acknowledged open position');
    await a.evaluate(); assert.equal(a.commands.length, 0); assert.equal(a.windows.get('south').manualHoldUntil, clock + HOUR);
    await a.stateChanged('thermalblindcontrol.0.global.enabled', { val: 'false', ts: clock, ack: false });
    assert.equal(a.controls.enabled, true); assert.equal(a.states.get('global.enabled').ack, true); assert.equal(a.states.get('global.enabled').val, true);
});
test('shared pending target at startup is not mistaken for actual position or enrollment', async t => {
    const c = baseConfig(); c.windows[0].positionCommandId = 'blind.actual';
    const a = await fixture(t, { native: c, participating: false, foreign: new Map([['blind.actual', { val: 100, ts: fixedNow, ack: false, from: 'system.adapter.admin.0' }]]) });
    assert.equal(a.position('south', clock), null); assert.equal(a.windows.get('south').participatingToday, false);
    assert(a.windows.get('south').manualHoldUntil > clock);
});
test('a hot room and diffuse facade radiation never close a window facing away from the sun', async t => {
    const c = baseConfig(); c.windows[0].azimuthDeg = 0;
    const a = await fixture(t, { native: c }); a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.commands.length, 0); assert.equal(a.states.get('windows.south.calculatedPosition').val, 100);
    assert(a.states.get('rooms.room.solarBudgetExceeded').val);
});
test('the adapter preserves 20 W of daylight per window when its heat budget is exhausted', async t => {
    const a = await fixture(t, { native: { minimumSolarPowerPerWindowW: 20 } }); a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.commands.length, 1);
    const potential = a.forecast.intervals[0].gti['180'] * 3 * 0.5;
    const openness = a.windows.get('south').ownCommand.target;
    assert(openness > 0); assert(potential * (openness / 100) >= 20 - 1e-7);
    assert(a.states.get('rooms.room.solarBudgetExceeded').val);
});
test('motor writes ignore 49 to 53 but perform 30 to 53 and the exact 10-point boundary', async t => {
    const c = baseConfig({ minimumSolarPowerPerWindowW: 79.5 });
    for (const [actual, moved] of [[49, false], [30, true], [43, true]]) {
        const r = newWindow(c.windows[0], c, fixedNow);
        r.actualPosition = actual; r.observationAnchor = actual; r.participatingToday = true;
        const states = new Map([['windows.south.runtime', { val: JSON.stringify(r), ack: true, ts: fixedNow }]]);
        const a = await fixture(t, { native: c, states, foreign: new Map([['blind.actual', { val: actual, ack: true, ts: fixedNow }]]) });
        a.startedAt -= 2 * HOUR;
        for (const interval of a.forecast.intervals) interval.gti['180'] = 100;
        await a.evaluate();
        assert.deepEqual(a.commands, moved ? [{ id: 'blind.target', val: 53, ack: false }] : [], `${actual} -> 53`);
        assert.equal(a.windows.get('south').lastAutoAt, moved ? fixedNow : 0);
    }
});
test('near-open plans publish 100 and command fully open using the configured device endpoints', async t => {
    for (const [actual, open, closed, moved] of [[70, 100, 0, true], [89, 0, 1, true], [95, 100, 0, false], [100, 100, 0, false]]) {
        const c = baseConfig({ minimumSolarPowerPerWindowW: 136.5 });
        c.windows[0].deviceOpenValue = open; c.windows[0].deviceClosedValue = closed;
        const r = newWindow(c.windows[0], c, fixedNow);
        r.actualPosition = actual; r.observationAnchor = actual; r.participatingToday = true;
        const states = new Map([['windows.south.runtime', { val: JSON.stringify(r), ack: true, ts: fixedNow }]]);
        const raw = closed + actual / 100 * (open - closed);
        const a = await fixture(t, { native: c, states, foreign: new Map([['blind.actual', { val: raw, ack: true, ts: fixedNow }]]) });
        a.startedAt -= 2 * HOUR;
        for (const interval of a.forecast.intervals) interval.gti['180'] = 100;
        await a.evaluate();
        assert.equal(a.states.get('windows.south.calculatedPosition').val, 100);
        assert.deepEqual(a.commands, moved ? [{ id: 'blind.target', val: open, ack: false }] : [], `actual ${actual}, endpoints ${open}/${closed}`);
        assert.equal(a.windows.get('south').lastAutoAt, moved ? fixedNow : 0);
    }
});
test('hourly movement cooldown remains active after adapter restart and releases at exactly 60 minutes', async t => {
    const a = await fixture(t, { native: { minMovementIntervalMinutes: 60 } }); a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.commands.length, 1);
    clock = fixedNow + MINUTE;
    await a.stateChanged('blind.actual', { val: 0, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    clock = fixedNow + 30 * MINUTE;
    const b = await fixture(t, { now: clock, native: { minMovementIntervalMinutes: 60 }, states: a.states,
        foreign: new Map([['blind.actual', { val: 0, ack: true, ts: clock }], ['room.temp', { val: 20, ack: true, ts: clock }]]) });
    b.startedAt -= 2 * HOUR; b.forecast = syntheticForecast(clock, b.settings, 2, 0, 0); b.dirty = true; await b.evaluate();
    assert.equal(b.commands.length, 0); assert.equal(b.windows.get('south').lastAutoAt, fixedNow);
    clock = fixedNow + HOUR; b.forecast = syntheticForecast(clock, b.settings, 2, 0, 0); b.dirty = true; await b.evaluate();
    assert.equal(b.commands.length, 1); assert.equal(b.commands[0].val, 100, 'the fresh forecast now permits reopening');
});
test('manual limits reach motor writes, survive own feedback and restart, and are published as diagnostics', async t => {
    const a = await fixture(t, { native: { respectManualPositionUntilEndOfDay: true },
        foreign: new Map([['room.temp', { val: 20, ack: true, ts: fixedNow }]]) });
    a.startedAt -= 2 * HOUR;
    a.forecast = syntheticForecast(clock, a.settings, -5, 0, 100); a.dirty = true; await a.evaluate();
    assert.equal(a.windows.get('south').lastPlannedPosition, 100);
    await a.stateChanged('blind.target', { val: 25, ack: false, ts: clock, from: 'system.adapter.admin.0' });
    assert.equal(a.windows.get('south').manualPositionLimit, null);
    clock += 30 * 1000;
    await a.stateChanged('blind.actual', { val: 25, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    assert.equal(a.windows.get('south').manualPositionLimit, 25);
    await a.evaluate(); assert.equal(a.states.get('windows.south.manualPositionLimit').val, 25);
    assert.equal(a.states.get('windows.south.manualPositionLimitActive').val, true);
    clock += 61 * MINUTE;
    a.forecast = syntheticForecast(clock, a.settings, 40, 0, 0); a.dirty = true; await a.evaluate();
    assert.deepEqual(a.commands, [{ id: 'blind.target', val: 0, ack: false }]);
    clock += 30 * 1000;
    await a.stateChanged('blind.actual', { val: 0, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    assert.equal(a.windows.get('south').manualPositionLimit, 25, 'automatic closing to zero must not change the manual preference');
    clock += 15 * MINUTE;
    a.forecast = syntheticForecast(clock, a.settings, -5, 0, 100); a.dirty = true; await a.evaluate();
    assert.deepEqual(a.commands[1], { id: 'blind.target', val: 25, ack: false });
    assert.equal(a.states.get('windows.south.calculatedPosition').val, 25);
    const b = await fixture(t, { now: clock + MINUTE, native: { respectManualPositionUntilEndOfDay: true }, states: a.states,
        foreign: new Map([['blind.actual', { val: 25, ack: true, ts: clock + MINUTE }]]) });
    assert.equal(b.windows.get('south').manualPositionLimit, 25);
    assert.equal(b.windows.get('south').manualHoldUntil, a.windows.get('south').manualHoldUntil);
    assert.equal(b.states.get('windows.south.manualPositionLimit').val, 25);
});
test('morning enrollment completes when the blind is already at its manual ceiling', async t => {
    const c = baseConfig({ respectManualPositionUntilEndOfDay: true }), morning = schedule(fixedNow, c).morning;
    const r = newWindow(c.windows[0], c, morning);
    r.actualPosition = 25; r.manualPositionLimit = 25; r.manualPositionLimitDate = localDate(morning, c.timezone);
    const g = newGlobal(c, morning); g.modeChangedAt = morning - 24 * HOUR;
    const states = new Map([
        ['windows.south.runtime', { val: JSON.stringify(r), ts: morning, ack: true }],
        ['global.runtime', { val: JSON.stringify(g), ts: morning, ack: true }],
    ]);
    const a = await fixture(t, { now: morning, native: c, states, foreign: new Map([['blind.actual', { val: 25, ts: morning, ack: true }]]) });
    a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.commands.length, 0); assert.equal(a.windows.get('south').participatingToday, true);
    assert.equal(a.windows.get('south').morningDate, localDate(morning, c.timezone));
});
test('intermediate manual feedback is compared with the pre-manual plan rather than the held position', async t => {
    const a = await fixture(t, { native: { respectManualPositionUntilEndOfDay: true } });
    a.startedAt -= 2 * HOUR; await a.evaluate();
    assert.equal(a.windows.get('south').lastPlannedPosition, 0);
    await a.stateChanged('blind.target', { val: 75, ack: false, ts: clock, from: 'system.adapter.admin.0' });
    clock += 1000;
    await a.stateChanged('blind.actual', { val: 75, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    await a.evaluate();
    assert.equal(a.windows.get('south').lastPlannedPosition, 0);
    clock += 1000;
    await a.stateChanged('blind.actual', { val: 74, ack: true, ts: clock, from: 'system.adapter.motor.0' });
    assert.equal(a.windows.get('south').manualPositionLimit, null, 'a more-open choice must not acquire a ceiling from intermediate/noisy feedback');
});
