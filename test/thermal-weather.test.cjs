const { test } = require('node:test');
const assert = require('node:assert/strict');
const { demoConfig, simulate, syntheticForecast } = require('../build/lib/simulator');
const { parseConfig } = require('../build/lib/config');
const { parseOpenMeteo, fetchForecast, forecastGrid, openMeteoAzimuth, forecastUrl, freshNumber } = require('../build/lib/weather');
const { capacity, rcStep, newRoomRuntime, updateHeating, optimizeRoom, transmission } = require('../build/lib/thermal');
const { HOUR, MINUTE } = require('../build/lib/time');
const c = parseConfig(demoConfig), now = Date.parse('2026-07-15T10:00:00Z');
const noHeating = { setpointC: 21, demand: false, valvePercent: 0, flowC: 40, returnC: 30 };
function constantGrid(temp = 5, gti = 500) { return Array.from({ length: 96 }, (_, i) => ({ start: now + i * 15 * MINUTE, end: now + (i + 1) * 15 * MINUTE, outsideC: temp, dni: 600, gti: Object.fromEntries(c.windows.map(w => [String(w.azimuthDeg), gti])) })); }
function optimize(temp, grid, room = c.rooms[0], observation = noHeating, runtime = newRoomRuntime(), windows = c.windows) {
    return optimizeRoom(room, windows.map(w => ({ config: w, position: 100, lastMoveAt: 0, movableAfter: now })), grid, temp, observation, runtime, c, now);
}
test('compass conversion and Open-Meteo request use vertical GTI and UTC epoch timestamps', () => {
    assert.deepEqual([70, 160, 250].map(openMeteoAzimuth), [-110, -20, 70]);
    assert.equal(openMeteoAzimuth(0), -180); assert.equal(openMeteoAzimuth(360), -180);
    const url = new URL(forecastUrl(c, 160)); assert.equal(url.searchParams.get('tilt'), '90'); assert.equal(url.searchParams.get('timeformat'), 'unixtime'); assert.equal(url.searchParams.get('forecast_days'), '3');
});
function payload(start = now) {
    return { hourly_units: { temperature_2m: '°C', global_tilted_irradiance: 'W/m²', direct_normal_irradiance: 'W/m²' }, hourly: {
        time: Array.from({ length: 49 }, (_, i) => (start + i * HOUR) / 1000), temperature_2m: Array(49).fill(20), global_tilted_irradiance: Array.from({ length: 49 }, (_, i) => i * 10), direct_normal_irradiance: Array(49).fill(600),
    } };
}
test('preceding-hour GTI is shifted correctly; temperatures are endpoint averages', () => {
    const raw = payload(); raw.hourly.temperature_2m[0] = 18;
    const series = parseOpenMeteo(raw, 160);
    assert.equal(series[0].start, now); assert.equal(series[0].end, now + HOUR); assert.equal(series[0].gti['160'], 10); assert.equal(series[0].outsideC, 19);
    raw.hourly.global_tilted_irradiance[1] = null; assert.equal(parseOpenMeteo(raw, 160)[0].start, now + HOUR);
    raw.hourly_units.temperature_2m = '°F'; assert.throws(() => parseOpenMeteo(raw, 160));
});
test('one forecast request per distinct facade; refresh failure rejects incomplete bundle', async () => {
    const requests = [];
    const config = { ...c, windows: [...c.windows, { ...c.windows[0], id: 'same-facade' }] };
    const f = await fetchForecast(config, now, async url => { requests.push(url); return { ok: true, json: async () => payload() }; });
    assert.equal(requests.length, 4); assert.equal(Object.keys(f.intervals[0].gti).length, 4);
    await assert.rejects(fetchForecast(c, now, async () => ({ ok: false, status: 429 })), /429/);
});
test('rolling 24h grid handles fractional hours and both DST transitions', () => {
    for (const start of [now + 37 * MINUTE, Date.parse('2026-03-28T18:37:00Z'), Date.parse('2026-10-24T18:37:00Z')]) {
        const hour = Math.floor(start / HOUR) * HOUR;
        const intervals = Array.from({ length: 27 }, (_, i) => ({ start: hour + i * HOUR, end: hour + (i + 1) * HOUR, outsideC: 10, dni: 600, gti: Object.fromEntries(c.windows.map(w => [String(w.azimuthDeg), 200])) }));
        const grid = forecastGrid({ fetchedAt: start, source: 'test', intervals }, c, start);
        assert.equal(grid[0].start, start); assert.equal(grid.at(-1).end, start + 24 * HOUR);
        assert.equal(grid.reduce((sum, p) => sum + p.end - p.start, 0), 24 * HOUR);
    }
});
test('stale/null/overlapping/incomplete forecasts and bad-quality sensors fail closed', () => {
    const valid = syntheticForecast(now, c, 20, 4, 0);
    for (const mutate of [f => f.fetchedAt = now - 181 * MINUTE, f => f.intervals.splice(4, 1), f => f.intervals[4].start = f.intervals[3].start,
        f => f.intervals[0].gti[String(c.windows[0].azimuthDeg)] = null, f => f.intervals.pop(), f => f.intervals[0].outsideC = NaN, f => f.location.latitude += 1]) {
        const f = structuredClone(valid); mutate(f); assert.equal(forecastGrid(f, c, now), null);
    }
    assert.equal(freshNumber({ val: 22, ts: now, q: 1 }, now, 30, -10, 50), null);
    assert.equal(freshNumber({ val: null, ts: now }, now, 30, -10, 50), null);
});
test('capacity, exact RC step and climate budget have correct units and remain numerically stable', () => {
    assert.equal(capacity(c.rooms[0]), 1150);
    assert.equal(rcStep(21, 21, 0, 80, 1150, 1), 21);
    assert(Math.abs(rcStep(50, 10, 0, 1000, 1, 1) - 10) < 0.001);
    const result = optimize(20, constantGrid(5, 0));
    assert.equal(result.climateBudget24h, 80 * 16 * 24); assert.equal(result.climateIndex, 16); assert.equal(result.adaptiveTempLimit, 25);
});
test('thermal transmission increases with openness from the closed floor at 0 to full transmission at 100', () => {
    const w = { ...c.windows[0], closedTransmission: 0.1 };
    assert.equal(transmission(w, 0), 0.1); assert.equal(transmission(w, 100), 1);
    assert.equal(transmission(w, 25), 0.325); assert.equal(transmission(w, 75), 0.775);
});
test('simulator inputs, runtime, daylight and export all use percent open', () => {
    const positions = { north: 0, east: 25, south: 75, west: 100 };
    const result = simulate({ scenario: 'balanced', positions, controls: { enabled: false } });
    assert.equal(result.positionConvention, 'percentOpen');
    for (const w of result.windows) {
        assert.equal(w.position, positions[w.id]); assert.equal(w.moved, false);
        assert.equal(result.runtime.windows[w.id].positionConvention, 'percentOpen');
        assert.equal(result.runtime.windows[w.id].actualPosition, positions[w.id]);
        const config = c.windows.find(window => window.id === w.id);
        assert(Math.abs(w.daylightPowerW - w.gti * config.glassAreaM2 * config.gValue * positions[w.id] / 100) < 1e-7);
    }
});
test('winter sunshine is admitted; a hot period tightens tolerance and honestly reports unavoidable overheating', () => {
    const winter = simulate({ scenario: 'winter' }); const hot = simulate({ scenario: 'heatwave' });
    assert.equal(winter.rooms[0].model.adaptiveTempLimit, 25); assert(winter.windows.every(w => w.position === 100));
    const model = hot.rooms[0].model; assert(model.climateBudget24h < 0); assert.equal(model.adaptiveTempLimit, 21);
    assert(model.predictedMaxTemp > 21); assert(model.predictedMaxTemp < model.openMaxTemp - 5); assert(model.unavoidableOverheating);
    assert(hot.windows.some(w => w.position < 100)); assert(model.solarAllowed24h < model.solarPotential24h);
});
test('vacation simulator shades sunlit windows without morning opt-in or normal enrollment', () => {
    for (const enabled of [true, false]) {
        const config = { ...c, vacationMode: true, minimumSolarPowerPerWindowW: 20,
            windows: c.windows.map(w => ({ ...w, enabled, autoMorningOpen: false })) };
        const result = simulate({ config, timestamp: now, scenario: 'heatwave' });
        assert(result.windows.some(w => w.directSun && w.moved && w.position > 0 && w.position < 100));
        assert(result.windows.filter(w => !w.directSun).every(w => w.position === 100));
        for (const w of result.windows) {
            assert.equal(w.participatingToday, false);
            assert.equal(w.autoMorningOpen, false); assert.equal(w.enabled, enabled);
            assert.equal(result.rooms[0].model.plan[0].positions[w.id], w.position, 'vacation planning and execution must agree');
        }
        const normal = simulate({ config, timestamp: now + MINUTE, scenario: 'heatwave', runtime: result.runtime, controls: { vacationMode: false } });
        assert(normal.windows.every(w => !w.moved && w.reason === (enabled ? 'WAIT_FIRST_OPEN' : 'WINDOW_DISABLED')));
        assert(normal.windows.every(w => !w.participatingToday && !w.autoMorningOpen));
    }
});
test('measured hot room receives less solar gain than cold room under the same climatic budget', () => {
    const grid = forecastGrid(syntheticForecast(now, c, 10, 0, 0), c, now);
    const cold = optimize(18, grid), hot = optimize(26, grid);
    assert.equal(cold.climateBudget24h, hot.climateBudget24h); assert(hot.solarAllowed24h < cold.solarAllowed24h);
    assert.equal(hot.predictedMaxTemp, 26); assert(cold.predictedMaxTemp < 26);
});
test('radiator estimates respond to solar warming instead of assuming constant 24-hour heat', () => {
    const room = structuredClone(c.rooms[0]); room.heating.type = 'radiator'; room.heating.nominalPowerW = 2000;
    const heating = { ...noHeating, demand: true, valvePercent: 100, flowC: 75, returnC: 65 };
    const dark = optimize(19, constantGrid(10, 0), room, heating), sunny = optimize(19, constantGrid(10, 400), room, heating);
    assert(sunny.heatingEnergyPredicted24h < dark.heatingEnergyPredicted24h);
    assert.equal(optimize(19, constantGrid(10, 0), room, noHeating).heatingEnergyPredicted24h, 0);
});
test('underfloor heating retains decaying residual warmth after demand turns off, including restart', () => {
    const room = structuredClone(c.rooms[0]); room.heating.type = 'underfloor';
    const runtime = newRoomRuntime(); updateHeating(room, { ...noHeating, demand: true, valvePercent: 100 }, 20, runtime, now);
    const initial = runtime.residualPowerW; assert(initial > 0);
    const restored = JSON.parse(JSON.stringify(runtime)); updateHeating(room, noHeating, 20, restored, now + HOUR);
    assert(restored.residualPowerW > 0 && restored.residualPowerW < initial);
    const result = optimize(20, constantGrid(15, 0), room, noHeating, restored);
    assert(result.heatingEnergyPredicted24h > 0); assert(result.plan.at(-1).heatingW < result.plan[0].heatingW);
});
test('each window respects its own hold; blocked positions remain part of the room heat balance', () => {
    const grid = constantGrid(30, 600), windows = c.windows.map((w, i) => ({ config: w, position: 100, lastMoveAt: 0, movableAfter: i === 0 ? Infinity : now }));
    const result = optimizeRoom(c.rooms[0], windows, grid, 25, noHeating, newRoomRuntime(), c, now);
    assert.equal(result.targets.north, 100); assert.equal(result.targets.south, 0);
    assert(result.plan.every(p => p.positions.north === 100));
});
test('simulator retains manual holds, supports independent rooms and resets on backwards scrubs', () => {
    const first = simulate({ scenario: 'heatwave' });
    const manual = simulate({ scenario: 'heatwave', timestamp: first.timestamp + MINUTE, runtime: first.runtime, manualChanges: { south: 100 } });
    assert.equal(manual.windows.find(w => w.id === 'south').reason, 'MANUAL_LOCK');
    const later = simulate({ scenario: 'heatwave', timestamp: first.timestamp + 30 * MINUTE, runtime: manual.runtime });
    assert.equal(later.windows.find(w => w.id === 'south').position, 100);
    const back = simulate({ scenario: 'winter', runtime: later.runtime }); assert.equal(back.runtime.windows.south.manualHoldUntil, 0);
    const multi = structuredClone(c); multi.rooms.push({ ...multi.rooms[0], id: 'bedroom', name: 'Bedroom', temperatureSensorId: 'sim.bedroom.temp' }); multi.windows[0].roomId = 'bedroom';
    const result = simulate({ config: multi, temperatures: { living: 26, bedroom: 18 }, scenario: 'summer' });
    assert.equal(result.rooms.length, 2); assert.notEqual(result.rooms[0].model.predictedMaxTemp, result.rooms[1].model.predictedMaxTemp);
});
test('simulator remembers manual closing, replaces it with manual opening, and clears it at midnight', () => {
    const config = { ...c, respectManualPositionUntilEndOfDay: true };
    let r = simulate({ config, scenario: 'winter' });
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + MINUTE, runtime: r.runtime, manualChanges: { north: 25 } });
    assert.equal(r.windows.find(w => w.id === 'north').manualPositionLimit, 25);
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + 61 * MINUTE, runtime: r.runtime });
    assert.equal(r.windows.find(w => w.id === 'north').position, 20);
    assert.equal(r.windows.find(w => w.id === 'north').reason, 'MANUAL_POSITION_LIMIT');
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + MINUTE, runtime: r.runtime, manualChanges: { north: 90 } });
    assert.equal(r.windows.find(w => w.id === 'north').manualPositionLimit, 90);
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + 61 * MINUTE, runtime: r.runtime });
    assert.equal(r.windows.find(w => w.id === 'north').position, 80);
    r = simulate({ config, scenario: 'winter', minutes: 23 * 60 + 45 });
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + MINUTE, runtime: r.runtime, manualChanges: { north: 0 } });
    assert.equal(r.windows.find(w => w.id === 'north').manualPositionLimit, 0);
    r = simulate({ config, scenario: 'winter', timestamp: r.timestamp + 30 * MINUTE, runtime: r.runtime });
    assert.equal(r.windows.find(w => w.id === 'north').manualPositionLimit, null);
    assert.equal(r.windows.find(w => w.id === 'north').manualPositionLimitActive, false);
});
