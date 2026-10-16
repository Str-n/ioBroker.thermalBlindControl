const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, defaults, roomDefaults, windowDefaults } = require('../build/lib/config');
const { minimumThermalPosition, newRoomRuntime, optimizeRoom, rcStep } = require('../build/lib/thermal');
const { forecastGrid, parseOpenMeteo } = require('../build/lib/weather');
const { simulate } = require('../build/lib/simulator');
const { HOUR, MINUTE, nextMidnight } = require('../build/lib/time');
const start = Date.parse('2026-07-15T10:00:00+02:00');
const heating = { setpointC: 21, demand: false, valvePercent: 0, flowC: null, returnC: null };
function fixture(profile = () => 1000, overrides = {}) {
    const c = parseConfig({ ...defaults, enabled: true, dryRun: false, thermalMode: 'active', toleranceMaxC: 0,
        rooms: [{ ...roomDefaults, id: 'room', temperatureSensorId: 'sim.room', heatLossWK: 100 }],
        windows: [{ ...windowDefaults, id: 'south', roomId: 'room', azimuthDeg: 180, glassAreaM2: 2, gValue: 0.5,
            closedTransmission: 0, positionStateId: 'sim.actual', positionCommandId: 'sim.target' }], ...overrides });
    const grid = Array.from({ length: 96 }, (_, i) => ({ start: start + i * 15 * MINUTE, end: start + (i + 1) * 15 * MINUTE,
        outsideC: 16, dni: i < 24 ? 1200 : 0, gti: { '180': i < 24 ? profile(i / 4) : 0 } }));
    const run = (temperature = 21, windows = c.windows.map(config => ({ config, position: 100, movableAfter: start, lastMoveAt: 0 }))) => optimizeRoom(c.rooms[0], windows, grid, temperature, heating, newRoomRuntime(), c, start);
    return { c, grid, run };
}
test('50% open is used throughout when it is sufficient; the blinds never jump to fully closed', () => {
    const { run } = fixture(); const m = run();
    assert.equal(m.targets.south, 50);
    assert(m.plan.slice(0, 24).every(p => p.positions.south === 50));
    assert(m.plan.slice(0, 24).every(p => Math.abs(p.solarW - 500) < 0.01));
    assert(m.plan.every(p => p.positions.south > 0));
    assert(m.predictedMaxTemp <= 21.01); assert(m.solarAllowed24h <= m.solarBudget24h + 0.01);
});
test('shading starts while the measured room is still cool, reserving capacity for the full day', () => {
    const { c, run } = fixture(); const m = run(20);
    assert(rcStep(20, 16, 1000, 100, 1150, 0.25) < 21, 'the first unshaded interval alone would still be comfortable');
    assert(m.targets.south > 0 && m.targets.south < 100, 'future sunshine must cause partial shading now');
    assert(m.plan.slice(0, 24).every(p => p.positions.south > 0));
    assert(m.predictedMaxTemp <= c.rooms[0].targetTemperatureC + 0.01);
});
test('the daily energy budget is spread evenly across weak and strong sunlight, with stronger closure at the midday peak', () => {
    // A configured 25°C limit leaves enough thermal headroom for 500 W, while the daily climate budget
    // allows only 2.4 kWh over six sunlit hours: the energy budget, rather than the temperature limit, must bind.
    const { grid, run } = fixture(hour => hour < 2 || hour >= 4 ? 600 : 1200, { toleranceStartK: -1, toleranceFullK: 0, toleranceMaxC: 4 });
    grid.forEach(p => { p.outsideC = 20; });
    const m = run(25), morning = m.plan[2], midday = m.plan[10], afternoon = m.plan[18];
    assert(midday.positions.south < morning.positions.south);
    assert(midday.positions.south < afternoon.positions.south);
    const admitted = [morning.solarW, midday.solarW, afternoon.solarW];
    assert(Math.max(...admitted) - Math.min(...admitted) <= 30, `room solar power must be flat: ${admitted}`);
    assert(m.plan.slice(0, 24).every(p => p.positions.south > 0 && p.positions.south > 0));
    assert(m.solarAllowed24h <= m.solarBudget24h + 0.01);
    assert.equal(m.solarBudget24h, 2400);
    assert(m.solarAllowed24h >= m.solarBudget24h * 0.99, 'the plan must use the available energy without wasting it');
});
test('a changing facade and diffuse radiation never cause closing without direct sun', () => {
    const r = simulate({ scenario: 'summer', outsideMean: 14, roomTemperature: 20 });
    const model = r.rooms[0].model;
    assert(r.windows.some(w => w.directSun && w.position > 0 && w.position < 100));
    assert(r.windows.filter(w => !w.directSun).every(w => w.position === 100));
    for (const p of model.plan) for (const [id, direct] of Object.entries(p.directSun)) if (!direct) assert.equal(p.positions[id], 100, `${id} must stay open at ${new Date(p.time).toISOString()}`);
    const { grid, run } = fixture(); grid.forEach(p => { p.dni = 0; p.gti['180'] = 1000; });
    const diffuse = run(); assert(diffuse.plan.every(p => p.positions.south === 100));
    assert(diffuse.solarBudgetExceeded, 'unavoidable diffuse heat must be reported instead of closing an unlit window');
});
test('forecast without trustworthy direct radiation is invalid rather than treating diffuse GTI as direct sunlight', () => {
    const { c, grid } = fixture(); const f = { source: 'test', fetchedAt: start, intervals: structuredClone(grid) };
    delete f.intervals[0].dni; assert.equal(forecastGrid(f, c, start), null);
    f.intervals[0].dni = null; assert.equal(forecastGrid(f, c, start), null);
    const raw = { hourly_units: { temperature_2m: '°C', global_tilted_irradiance: 'W/m²' }, hourly: { time: [], temperature_2m: [], global_tilted_irradiance: [] } };
    assert.throws(() => parseOpenMeteo(raw, 180));
});
test('receding-horizon playback keeps partial shading through the day and never closes an unlit facade', () => {
    let r = simulate({ scenario: 'balanced', minutes: 480 }), partialMoves = 0;
    for (let i = 0; i < 56; i++) {
        if (i) r = simulate({ scenario: 'balanced', timestamp: r.timestamp + 15 * MINUTE, runtime: r.runtime });
        for (const w of r.windows) {
            if (w.moved && w.position < w.previousPosition) assert(w.directSun, `unlit closure: ${w.id}`);
            if (w.moved && w.position > 0 && w.position < 100) partialMoves++;
            assert(w.position > 0, 'the balanced scenario must not turn into full closing later in the day');
        }
        assert(Number.isFinite(r.rooms[0].temperature));
    }
    assert(partialMoves > 4, 'the controller must adjust partial shading as the sun moves across facades');
});
test('manual holds remain fixed and their heat is included when allocating the remaining windows', () => {
    const { c, grid } = fixture(); const south = c.windows[0], other = { ...south, id: 'other' };
    const m = optimizeRoom(c.rooms[0], [{ config: south, position: 100, movableAfter: Infinity, lastMoveAt: 0 }, { config: other, position: 100, movableAfter: start, lastMoveAt: 0 }], grid, 21, heating, newRoomRuntime(), c, start);
    assert(m.plan.every(p => p.positions.south === 100));
    assert(m.targets.other < 10); assert(m.unavoidableOverheating);
});
test('minimum daylight remains admitted per window even when the heat budget is exhausted', () => {
    const { c, grid, run } = fixture(() => 100, { minimumSolarPowerPerWindowW: 20 });
    grid.forEach(p => { p.outsideC = 30; });
    const m = run(30);
    assert.equal(m.solarBudget24h, 0); assert(m.solarBudgetExceeded);
    assert.equal(m.targets.south, 20);
    assert(m.plan.slice(0, 24).every(p => Math.abs(p.solarW - 20) < 1e-7));
    const other = { ...c.windows[0], id: 'other', glassAreaM2: 4 };
    const multi = optimizeRoom(c.rooms[0], [c.windows[0], other].map(config => ({ config, position: 100, movableAfter: start, lastMoveAt: 0 })), grid, 30, heating, newRoomRuntime(), c, start);
    assert.equal(multi.targets.south, 20); assert.equal(multi.targets.other, 10);
    assert(Math.abs(multi.plan[0].solarW - 40) < 1e-7, 'the minimum is per window, not shared across the room');
});
test('the forecast retains actual positions for sub-threshold daylight corrections and plans sufficiently large moves', () => {
    const { c, grid, run } = fixture(() => 100, { minimumSolarPowerPerWindowW: 53 });
    grid.forEach(p => { p.outsideC = 30; });
    for (const [position, expected] of [[49, 49], [30, 53], [43, 53], [57, 57]]) {
        const m = run(30, [{ config: c.windows[0], position, movableAfter: start, lastMoveAt: 0 }]);
        assert.equal(m.targets.south, expected, `actual ${position}, requested 53`);
        assert(Math.abs(m.plan[0].solarW - expected) < 1e-7, 'heat balance must use the held position');
        let previous = position;
        for (const p of m.plan) {
            const delta = Math.abs(p.positions.south - previous);
            assert(delta === 0 || delta >= c.minPositionChange, `forecast move ${previous} -> ${p.positions.south}`);
            previous = p.positions.south;
        }
    }
});
test('the forecast includes near-open snapping and retained sub-threshold positions in the heat balance', () => {
    const { c, grid, run } = fixture(() => 100, { minimumSolarPowerPerWindowW: 91 });
    grid.forEach(p => { p.outsideC = 30; });
    for (const [position, expected] of [[70, 100], [89, 100], [90, 100], [95, 95], [100, 100]]) {
        const m = run(30, [{ config: c.windows[0], position, movableAfter: start, lastMoveAt: 0 }]);
        assert.equal(m.targets.south, expected, `actual ${position}, requested 91`);
        assert(m.plan.slice(0, 24).every(p => p.positions.south === expected && p.solarW === expected));
        assert(Math.abs(m.plan[0].temperature - rcStep(30, 30, expected, c.rooms[0].heatLossWK, m.capacityWhK, 0.25)) < 1e-7);
        assert(m.solarBudgetExceeded, 'the heat from the snapped daylight allowance must remain visible');
    }
    const boundary = fixture(() => 100, { minimumSolarPowerPerWindowW: 90 });
    boundary.grid.forEach(p => { p.outsideC = 30; });
    assert.equal(boundary.run(30, [{ config: boundary.c.windows[0], position: 70, movableAfter: start, lastMoveAt: 0 }]).targets.south, 90);
    for (const maximumPosition of [0, 25, 90, 95]) {
        const m = run(30, [{ config: c.windows[0], position: 0, movableAfter: start, lastMoveAt: 0, maximumPosition, maximumPositionUntil: nextMidnight(start, c.timezone) }]);
        assert.equal(m.targets.south, maximumPosition);
        assert(m.plan.filter(p => p.time <= nextMidnight(start, c.timezone)).every(p => p.positions.south <= maximumPosition));
        assert.equal(m.plan[0].solarW, maximumPosition);
    }
});
test('reopening without direct sun obeys the same threshold in the forecast', () => {
    const { c, grid, run } = fixture(); grid.forEach(p => { p.dni = 0; });
    for (const [position, expected] of [[96, 96], [91, 91], [90, 100], [70, 100]]) {
        const m = run(21, [{ config: c.windows[0], position, movableAfter: start, lastMoveAt: 0 }]);
        assert.equal(m.targets.south, expected);
        assert(m.plan.every(p => p.positions.south === expected));
    }
});
test('the complete forecast honors a manual opening ceiling, its heat balance, and local-midnight expiry', () => {
    const { c, run } = fixture(), midnight = nextMidnight(start, c.timezone);
    const m = run(21, [{ config: c.windows[0], position: 25, movableAfter: start, lastMoveAt: 0, maximumPosition: 25, maximumPositionUntil: midnight }]);
    assert.equal(m.targets.south, 25);
    assert(m.plan.filter(p => p.time <= midnight).every(p => p.positions.south <= 25));
    assert(m.plan.slice(0, 24).every(p => p.solarW === 250));
    assert.equal(m.plan.find(p => p.time > midnight).positions.south, 100, 'the next day must no longer inherit the ceiling');
    assert(m.openPlan.every(p => p.positions.south === 100), 'all-open reference remains an explicitly hypothetical comparison');
});
test('manual closing to zero overrides the daylight floor without removing the allowance for another window', () => {
    const { c, grid } = fixture(() => 100, { minimumSolarPowerPerWindowW: 20 });
    grid.forEach(p => { p.outsideC = 30; });
    const second = { ...c.windows[0], id: 'second' }, midnight = nextMidnight(start, c.timezone);
    const m = optimizeRoom(c.rooms[0], [
        { config: c.windows[0], position: 0, movableAfter: start, lastMoveAt: 0, maximumPosition: 0, maximumPositionUntil: midnight },
        { config: second, position: 100, movableAfter: start, lastMoveAt: 0 },
    ], grid, 30, heating, newRoomRuntime(), c, start);
    assert.equal(m.targets.south, 0); assert.equal(m.targets.second, 20);
    assert(m.plan.filter(p => p.time <= midnight).every(p => p.positions.south === 0));
    assert.equal(m.plan[0].solarW, 20);
});
test('low sunlight is fully admitted and residual heat from a closed blind never counts as daylight', () => {
    const { grid, run } = fixture(() => 10, { minimumSolarPowerPerWindowW: 20 });
    grid.forEach(p => { p.outsideC = 30; });
    const m = run(30); assert.equal(m.targets.south, 100); assert.equal(m.plan[0].solarW, 10);
    assert.equal(minimumThermalPosition(1000, 20), 2);
    assert.equal(minimumThermalPosition(1000, 0), 0);
    assert.equal(minimumThermalPosition(10, 20), 100);
    const r = simulate({ scenario: 'heatwave', config: { ...require('../build/lib/simulator').demoConfig, minimumSolarPowerPerWindowW: 20 } });
    assert(r.windows.every(w => w.position > 0));
    assert(r.windows.every(w => w.daylightPowerW + 1e-7 >= w.minimumSolarW));
});
test('a 60-minute movement interval shades in advance of strong sun arriving within the next hour', () => {
    const profile = hour => hour < 0.5 ? 100 : 1000;
    const hourly = fixture(profile, { minMovementIntervalMinutes: 60 }).run(20);
    const quarterHourly = fixture(profile, { minMovementIntervalMinutes: 15 }).run(20);
    assert.equal(quarterHourly.targets.south, 100, 'weak sun alone needs no shade at the current temperature');
    assert(hourly.targets.south > 0 && hourly.targets.south < 100, 'the held position must anticipate the stronger sun');
    assert(hourly.plan.slice(0, 4).every(p => p.positions.south === hourly.targets.south), 'one position must cover the full hour');
    assert(hourly.predictedMaxTemp <= 21.01, 'the forecast must remain comfortable while the position is held');
    let previous = 100, lastMove = -Infinity;
    for (const [i, p] of hourly.plan.entries()) if (p.positions.south !== previous) {
        assert(i * 15 * MINUTE - lastMove >= HOUR, 'forecast plan must obey the same hourly lockout as the adapter');
        previous = p.positions.south; lastMove = i * 15 * MINUTE;
    }
});
test('the hourly held position preserves the daylight minimum when sunlight fades before the next permitted move', () => {
    const { grid, run } = fixture(hour => hour < 0.5 ? 1000 : 100, { minMovementIntervalMinutes: 60, minimumSolarPowerPerWindowW: 20 });
    grid.forEach(p => { p.outsideC = 30; });
    const m = run(30);
    assert.equal(m.targets.south, 20, '2% open now would leave too little daylight later in the hour');
    assert(m.plan.slice(0, 4).every(p => p.positions.south === 20));
    assert(m.plan.slice(0, 24).every(p => p.solarW >= 20 - 1e-7));
});
test('daylight and movement settings validate and keep previous defaults for saved configurations', () => {
    const { c } = fixture(); assert.equal(c.minimumSolarPowerPerWindowW, 0); assert.equal(c.minMovementIntervalMinutes, 15); assert.equal(c.minPositionChange, 10); assert.equal(c.respectManualPositionUntilEndOfDay, false);
    assert.equal(parseConfig({ ...c, minimumSolarPowerPerWindowW: 20, minMovementIntervalMinutes: 60 }).minMovementIntervalMinutes, 60);
    for (const value of [-1, NaN, Infinity, null, true, '']) assert.throws(() => parseConfig({ ...c, minimumSolarPowerPerWindowW: value }));
    for (const value of [0, 101, NaN, Infinity, null, true, '']) assert.throws(() => parseConfig({ ...c, minPositionChange: value }));
    for (const value of [0, 1, 'true', null]) assert.throws(() => parseConfig({ ...c, respectManualPositionUntilEndOfDay: value }));
});
