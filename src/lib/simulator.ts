import { defaults, parseConfig, roomDefaults, windowDefaults, type Config } from './config';
import { beginCommand, completeEvent, dailyManualPositionLimit, decide, manualAction, newGlobal, newWindow, observe, positionForForecast, restoreWindow, rollover, type GlobalRuntime, type WindowRuntime } from './engine';
import { capacity, minimumThermalPosition, newRoomRuntime, optimizeRoom, rcStep, transmission, updateHeating, type HeatingObservation, type RoomRuntime, type ThermalResult } from './thermal';
import { directIrradiance, forecastGrid, hasDirectSun, orientationKey, type Forecast } from './weather';
import { atLocal, clamp, HOUR, localParts, MINUTE, nextMidnight, schedule, solarPosition } from './time';

export const demoConfig: Config = parseConfig({ ...defaults, enabled: true, dryRun: false, thermalMode: 'active', startupDelaySeconds: 0,
    rooms: [{ ...roomDefaults, id: 'living', name: 'Living room', temperatureSensorId: 'sim.living.temperature' }],
    windows: [{ id: 'north', azimuthDeg: 0, glassAreaM2: 2 }, { id: 'east', azimuthDeg: 90, glassAreaM2: 3.5 },
        { id: 'south', azimuthDeg: 180, glassAreaM2: 5 }, { id: 'west', azimuthDeg: 270, glassAreaM2: 4 }]
        .map(w => ({ ...windowDefaults, ...w, name: w.id[0].toUpperCase() + w.id.slice(1), roomId: 'living', positionStateId: `sim.${w.id}.actual`, positionCommandId: `sim.${w.id}.target` })),
});
export const scenarios = {
    balanced: { mean: 14, swing: 6, clouds: 15, roomC: 20, date: '2026-07-15' },
    winter: { mean: 2, swing: 4, clouds: 10, roomC: 20, date: '2026-01-15' },
    summer: { mean: 23, swing: 6, clouds: 15, roomC: 22, date: '2026-07-15' },
    heatwave: { mean: 31, swing: 4, clouds: 5, roomC: 26, date: '2026-07-20' },
    cloudy: { mean: 14, swing: 3, clouds: 90, roomC: 21, date: '2026-10-15' },
} as const;
export interface SimulationRuntime {
    timestamp: number; global: GlobalRuntime; windows: Record<string, WindowRuntime>;
    rooms: Record<string, RoomRuntime>; temperatures: Record<string, number>;
}
export interface SimulatorRequest {
    timestamp?: number; date?: string; minutes?: number; scenario?: keyof typeof scenarios; config?: unknown;
    outsideMean?: number; clouds?: number; roomTemperature?: number; temperatures?: Record<string, number>;
    heatLossWK?: number; floorAreaM2?: number; heatingType?: 'none' | 'radiator' | 'underfloor'; heatingDemand?: boolean;
    positions?: Record<string, number>; manualChanges?: Record<string, number>;
    controls?: Partial<Pick<GlobalRuntime, 'enabled' | 'disabledToday' | 'vacationMode' | 'dryRun'>>;
    flags?: Record<string, { enabled?: boolean; autoMorningOpen?: boolean }>;
    forecastFailure?: boolean; sensorFailure?: boolean; runtime?: SimulationRuntime;
}
function bounded(value: unknown, fallback: number, min: number, max: number): number { return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback; }
function conditions(time: number, c: Config, mean: number, swing: number, clouds: number): { outsideC: number; dni: number; gti: Record<string, number> } {
    const p = localParts(time, c.timezone), hour = Number(p.hour) + Number(p.minute) / 60;
    const outsideC = mean + swing * Math.cos((hour - 15) / 24 * 2 * Math.PI);
    const sun = solarPosition(time, c);
    const elevation = sun.elevation * Math.PI / 180;
    const gti: Record<string, number> = {};
    const dni = sun.elevation <= 0 ? 0 : 750 * clamp(Math.sin(elevation) * 4) * (1 - clouds / 100) ** 2;
    for (const w of c.windows) {
        const incidence = Math.max(0, Math.cos((sun.azimuth - w.azimuthDeg) * Math.PI / 180) * Math.cos(elevation));
        gti[orientationKey(w.azimuthDeg)] = sun.elevation <= 0 ? 0 : dni * incidence + 95 * Math.sin(elevation) * (1 - clouds / 150);
    }
    return { outsideC, dni, gti };
}
export function syntheticForecast(now: number, c: Config, mean: number, swing: number, clouds: number): Forecast {
    return { fetchedAt: now, source: 'Synthetic scenario (not measured weather)', location: { latitude: c.latitude, longitude: c.longitude }, intervals: Array.from({ length: 96 }, (_, i) => ({
        start: now + i * 15 * MINUTE, end: now + (i + 1) * 15 * MINUTE,
        ...conditions(now + (i + 0.5) * 15 * MINUTE, c, mean, swing, clouds),
    })) };
}
export function simulate(request: SimulatorRequest): Record<string, unknown> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected simulation object');
    const scenario = scenarios[request.scenario ?? 'summer'] ?? scenarios.summer;
    const raw = request.config ?? demoConfig;
    const c = parseConfig(raw);
    for (const r of c.rooms) {
        if (request.heatLossWK !== undefined) r.heatLossWK = bounded(request.heatLossWK, r.heatLossWK, 1, 2000);
        if (request.floorAreaM2 !== undefined) r.floorAreaM2 = bounded(request.floorAreaM2, r.floorAreaM2, 1, 1000);
        if (request.heatingType !== undefined && ['none', 'radiator', 'underfloor'].includes(request.heatingType)) r.heating.type = request.heatingType;
    }
    const day = request.date ?? scenario.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) throw new Error('Invalid simulation date');
    const minute = Math.floor(bounded(request.minutes, 12 * 60, 0, 1439));
    const now = request.timestamp === undefined ? atLocal(day, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, c.timezone) : request.timestamp;
    if (!Number.isFinite(now) || now < Date.parse('2020-01-01') || now > Date.parse('2100-01-01')) throw new Error('Invalid simulation timestamp');
    const mean = bounded(request.outsideMean, scenario.mean, -20, 45), clouds = bounded(request.clouds, scenario.clouds, 0, 100);
    // Time reversal and large scrubs start a fresh run; small forward steps evolve the virtual room.
    const previous = request.runtime && request.runtime.timestamp <= now && now - request.runtime.timestamp <= 2 * HOUR ? request.runtime : null;
    const runtime: SimulationRuntime = { timestamp: now, global: newGlobal(c, now), windows: {}, rooms: {}, temperatures: {} };
    runtime.global.modeChangedAt = now - 24 * HOUR;
    if (previous?.global) {
        for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun'] as const) if (typeof previous.global[key] === 'boolean') runtime.global[key] = previous.global[key];
        for (const key of ['day', 'disabledDate'] as const) if (typeof previous.global[key] === 'string') runtime.global[key] = previous.global[key];
        runtime.global.modeChangedAt = bounded(previous.global.modeChangedAt, now, 0, now);
    }
    for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun'] as const) if (typeof request.controls?.[key] === 'boolean') {
        if (key === 'vacationMode' && previous && runtime.global[key] !== request.controls[key]) runtime.global.modeChangedAt = now;
        runtime.global[key] = request.controls[key]!;
        if (key === 'disabledToday' && runtime.global.disabledToday && !runtime.global.disabledDate) runtime.global.disabledDate = `${localParts(now, c.timezone).year}-${localParts(now, c.timezone).month}-${localParts(now, c.timezone).day}`;
    }
    for (const w of c.windows) {
        const r = previous?.windows?.[w.id] ? restoreWindow(previous.windows[w.id], w, c, now) : newWindow(w, c, now);
        if (!previous) {
            r.actualPosition = bounded(request.positions?.[w.id], 100, 0, 100);
            // The default virtual house starts with an already completed morning routine.
            if (r.autoMorningOpen && now >= schedule(now, c).morning) { r.participatingToday = true; r.morningDate = r.day; }
        }
        for (const key of ['enabled', 'autoMorningOpen'] as const) if (typeof request.flags?.[w.id]?.[key] === 'boolean') r[key] = request.flags[w.id][key]!;
        if (!previous && !r.autoMorningOpen) { r.participatingToday = false; r.morningDate = ''; }
        runtime.windows[w.id] = r;
    }
    const previousPositions = Object.fromEntries(c.windows.map(w => [w.id, runtime.windows[w.id].actualPosition ?? 100]));
    const dayChanged = rollover(runtime.global, Object.values(runtime.windows), now, c);
    for (const w of c.windows) {
        const value = request.manualChanges?.[w.id];
        if (typeof value === 'number' && Number.isFinite(value)) {
            runtime.windows[w.id].actualPosition = clamp(value, 0, 100);
            manualAction(runtime.windows[w.id], runtime.windows[w.id].actualPosition, now, c);
        }
    }
    const forecast = syntheticForecast(now, c, mean, scenario.swing, clouds), grid = forecastGrid(forecast, c, now)!;
    const models: Record<string, ThermalResult | null> = {};
    for (const room of c.rooms) {
        const old = previous?.rooms?.[room.id];
        const r = newRoomRuntime();
        if (old) {
            r.residualPowerW = bounded(old.residualPowerW, 0, 0, 40000);
            r.heatingUpdatedAt = bounded(old.heatingUpdatedAt, now, 0, now);
            r.adaptiveLimit = old.adaptiveLimit === null ? null : bounded(old.adaptiveLimit, room.targetTemperatureC, 10, 40);
            r.limitUpdatedAt = bounded(old.limitUpdatedAt, now, 0, now);
        }
        runtime.rooms[room.id] = r;
        let temperature = bounded(request.temperatures?.[room.id] ?? request.roomTemperature ?? previous?.temperatures?.[room.id], scenario.roomC, -10, 55);
        const observation: HeatingObservation = { demand: request.heatingDemand ?? false, setpointC: room.targetTemperatureC,
            valvePercent: request.heatingDemand ? 100 : 0, flowC: room.heating.type === 'underfloor' ? 35 : 55, returnC: room.heating.type === 'underfloor' ? 28 : 40 };
        const roomWindows = c.windows.filter(w => w.roomId === room.id);
        if (previous && now > previous.timestamp && request.roomTemperature === undefined && request.temperatures?.[room.id] === undefined) {
            for (let time = previous.timestamp; time < now;) {
                const next = Math.min(time + 5 * MINUTE, now), weather = conditions((time + next) / 2, c, mean, scenario.swing, clouds);
                const solar = roomWindows.reduce((sum, w) => sum + weather.gti[orientationKey(w.azimuthDeg)] * w.glassAreaM2 * w.gValue * transmission(w, previousPositions[w.id]), 0);
                updateHeating(room, observation, temperature, r, next);
                const heating = room.heating.type === 'underfloor' ? r.residualPowerW : room.heating.type === 'radiator' && observation.demand && temperature < room.targetTemperatureC ? room.heating.nominalPowerW * 0.5 : 0;
                temperature = rcStep(temperature, weather.outsideC, solar + heating + room.internalGainsW, room.heatLossWK, capacity(room), (next - time) / HOUR); time = next;
            }
        }
        runtime.temperatures[room.id] = temperature;
        updateHeating(room, observation, temperature, r, now);
        models[room.id] = request.forecastFailure || request.sensorFailure ? null : optimizeRoom(room, roomWindows.map(w => ({ config: w,
            position: positionForForecast(runtime.windows[w.id], runtime.windows[w.id].actualPosition ?? 100, now), lastMoveAt: runtime.windows[w.id].lastAutoAt,
            maximumPosition: dailyManualPositionLimit(runtime.windows[w.id], c, now) ?? 100, maximumPositionUntil: nextMidnight(now, c.timezone),
            movableAfter: runtime.global.vacationMode || runtime.windows[w.id].enabled && runtime.windows[w.id].participatingToday ? Math.max(now, runtime.windows[w.id].manualHoldUntil) : Infinity,
        })), grid, temperature, observation, r, c, now);
    }
    const windows = c.windows.map(w => {
        const r = runtime.windows[w.id], result = models[w.roomId];
        const potentialW = grid[0].gti[orientationKey(w.azimuthDeg)] * w.glassAreaM2 * w.gValue;
        const decision = decide({ config: c, global: runtime.global, runtime: r, now, actualPosition: r.actualPosition,
            thermalTarget: result?.targets[w.id] ?? null, forecastValid: !request.forecastFailure, roomValid: !request.sensorFailure && !!result, startupReady: true, dayChanged,
            directSun: hasDirectSun(grid[0], w.azimuthDeg, c, now), minimumThermalPosition: minimumThermalPosition(potentialW, c.minimumSolarPowerPerWindowW) });
        if (r.manualHoldUntil <= now) r.lastPlannedPosition = decision.calculatedPosition;
        const before = r.actualPosition;
        if (decision.target !== null) {
            beginCommand(r, w, decision.target, decision.reason, now, `sim-${w.id}-${now}`);
            // Virtual motor completes immediately, through the same feedback recognizer as the real adapter.
            observe(r, { kind: 'actual', position: decision.target, ts: now, ack: true, from: 'system.adapter.virtual.0' }, c, now, 'system.adapter.thermalblindcontrol.0');
            completeEvent(r, decision.event, now, c);
        } else if ((decision.reason === 'NO_CHANGE' || decision.reason === 'MANUAL_POSITION_LIMIT') && decision.event) completeEvent(r, decision.event, now, c);
        return { id: w.id, name: w.name, roomId: w.roomId, azimuth: w.azimuthDeg, position: r.actualPosition, previousPosition: before,
            calculatedPosition: decision.calculatedPosition, reason: decision.reason, moved: decision.target !== null,
            gti: grid[0].gti[orientationKey(w.azimuthDeg)], directIrradiance: directIrradiance(grid[0], w.azimuthDeg, c, now), directSun: hasDirectSun(grid[0], w.azimuthDeg, c, now),
            admittedSolarW: potentialW * transmission(w, r.actualPosition ?? 100), daylightPowerW: potentialW * ((r.actualPosition ?? 100) / 100), minimumSolarW: Math.min(potentialW, c.minimumSolarPowerPerWindowW),
            manualHoldUntil: r.manualHoldUntil, manualPositionLimit: dailyManualPositionLimit(r, c, now), manualPositionLimitActive: dailyManualPositionLimit(r, c, now) !== null,
            participatingToday: r.participatingToday, enabled: r.enabled, autoMorningOpen: r.autoMorningOpen };
    });
    return { positionConvention: 'percentOpen', timestamp: now, timezone: c.timezone, sun: solarPosition(now, c), outsideTemperature: grid[0].outsideC,
        forecastValid: !request.forecastFailure, schedule: schedule(now, c), windows,
        rooms: c.rooms.map(room => ({ id: room.id, name: room.name, temperature: runtime.temperatures[room.id], residualPowerW: runtime.rooms[room.id].residualPowerW, model: models[room.id] })), runtime };
}
