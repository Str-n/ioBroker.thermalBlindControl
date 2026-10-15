const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { parseConfig, defaults, roomDefaults, windowDefaults } = require('../build/lib/config');
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
        this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
    }
    async setObjectNotExistsAsync(id, obj) { if (!this.objects.has(id)) this.objects.set(id, obj); }
    async getStateAsync(id) { return this.states.get(id) || null; }
    async setStateAsync(id, val, ack) { this.states.set(id, { val, ack, ts: Date.now() }); if (this.writeHook) await this.writeHook(id, val); }
    async setStateChangedAsync(...args) { await this.setStateAsync(...args); }
    async subscribeStatesAsync() {}
    async subscribeForeignStatesAsync(id) { this.subscriptions.add(id); }
    async getForeignStateAsync(id) { return this.foreign.get(id) || null; }
    async setForeignStateAsync(id, val, ack) {
        const window = this.config.windows.find(w => w.positionCommandId === id);
        assert(window, 'only configured blind actuators can be written');
        const runtime = JSON.parse(this.states.get(`windows.${window.id}.runtime`).val);
        assert(runtime.lastAutoAt > 0, 'cooldown must be durable before command'); assert(runtime.ownCommand?.id, 'identity must be durable before command');
        this.commands.push({ id, val, ack }); if (this.failCommand) throw new Error('simulated delivery failure');
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
        for (const w of c.windows) { const r = newWindow(w, c, clock); r.participatingToday = options.participating ?? true; r.actualPosition = 100; states.set(`windows.${w.id}.runtime`, state(JSON.stringify(r))); }
        const g = newGlobal(c, clock); g.modeChangedAt = clock - 24 * HOUR; states.set('global.runtime', state(JSON.stringify(g)));
    }
    const foreign = new Map([...c.rooms.map(r => [r.temperatureSensorId, state(27)]), ...c.windows.map(w => [w.positionStateId, state(w.deviceOpenValue)])]);
    for (const [id, sample] of options.foreign || []) foreign.set(id, sample);
    const a = create({ native: c, states, foreign });
    a.refreshForecast = async () => {};
    t.after(() => new Promise(resolve => a.emit('unload', resolve)));
    await a.ready();
    assert.equal(a.logs.filter(l => l.level === 'error').length, 0, JSON.stringify(a.logs));
    a.forecast = syntheticForecast(clock, c, 31, 3, 0); a.dirty = true;
    return a;
}
test('startup creates persistent writable controls, subscribes inputs and delays every motor command', async t => {
    const a = await fixture(t); await a.evaluate();
    assert.equal(a.commands.length, 0); assert.equal(a.states.get('windows.south.controlReason').val, 'STARTUP_DELAY');
    assert(a.objects.get('global.enabled').common.write); assert(!a.objects.get('windows.south.runtime').common.write);
    assert(a.subscriptions.has('blind.actual')); assert(a.subscriptions.has('room.temp'));
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
test('motor writes ignore 89 to 93 but perform 70 to 93 and the exact 10-point boundary', async t => {
    const c = baseConfig({ minimumSolarPowerPerWindowW: 139.5 });
    for (const [actual, moved] of [[89, false], [70, true], [83, true]]) {
        const r = newWindow(c.windows[0], c, fixedNow);
        r.actualPosition = actual; r.observationAnchor = actual; r.participatingToday = true;
        const states = new Map([['windows.south.runtime', { val: JSON.stringify(r), ack: true, ts: fixedNow }]]);
        const a = await fixture(t, { native: c, states, foreign: new Map([['blind.actual', { val: actual, ack: true, ts: fixedNow }]]) });
        a.startedAt -= 2 * HOUR;
        for (const interval of a.forecast.intervals) interval.gti['180'] = 100;
        await a.evaluate();
        assert.deepEqual(a.commands, moved ? [{ id: 'blind.target', val: 93, ack: false }] : [], `${actual} -> 93`);
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
