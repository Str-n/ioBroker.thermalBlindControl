import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { randomUUID } from 'node:crypto';
import { parseConfig, migrateLegacyConfig, normalizePosition, devicePosition, type Config, type RoomConfig, type WindowConfig } from './lib/config';
import { beginCommand, completeEvent, dailyManualPositionLimit, decide, newGlobal, newWindow, observe, positionForForecast, restoreWindow, rollover, type GlobalRuntime, type PositionEvent, type WindowRuntime } from './lib/engine';
import { minimumThermalPosition, newRoomRuntime, optimizeRoom, updateHeating, type HeatingObservation, type RoomRuntime, type ThermalResult } from './lib/thermal';
import { directIrradiance, fetchForecast, forecastGrid, freshNumber, hasDirectSun, orientationKey, type Forecast, type Sample } from './lib/weather';
import { localDate, MINUTE, nextMidnight, schedule } from './lib/time';

export class ThermalBlindControl extends Adapter {
    private settings!: Config;
    private controls!: GlobalRuntime;
    private readonly windows = new Map<string, WindowRuntime>();
    private readonly rooms = new Map<string, RoomRuntime>();
    private readonly inputs = new Map<string, Sample>();
    private readonly results = new Map<string, ThermalResult>();
    private forecast: Forecast | null = null;
    private lastOptimization = 0;
    private planValidUntil = Infinity;
    private dirty = true;
    private startedAt = 0;
    private stopped = false;
    private initialized = false;
    private revision = 0;
    private readonly receivedFeedback = new Map<string, { commandId: string; runtime: WindowRuntime }>();
    private queue: Promise<void> = Promise.resolve();
    private tick?: ReturnType<typeof setInterval>;
    private midnight?: ReturnType<typeof setTimeout>;
    private startup?: ReturnType<typeof setTimeout>;
    private weatherTimer?: ReturnType<typeof setTimeout>;
    private debounce?: ReturnType<typeof setTimeout>;
    private forecastRunning = false;
    constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'thermalblindcontrol' });
        this.on('ready', () => this.enqueue(() => this.ready()));
        this.on('stateChange', (id, state) => {
            if (id.startsWith(`${this.namespace}.`) && state?.ack) return;
            if (!this.expectedMotorFeedback(id, state)) this.revision++;
            this.enqueue(() => this.stateChanged(id, state));
        });
        this.on('unload', callback => {
            this.stopped = true; this.revision++;
            clearInterval(this.tick); clearTimeout(this.midnight); clearTimeout(this.startup); clearTimeout(this.weatherTimer); clearTimeout(this.debounce);
            void this.queue.finally(() => this.setStateAsync('info.connection', false, true)).finally(callback);
        });
    }
    private enqueue(task: () => Promise<void>): void {
        this.queue = this.queue.then(async () => { if (!this.stopped) await task(); }).catch(error => this.log.error(String(error)));
    }
    private motorEvent(w: WindowConfig, id: string, state: ioBroker.State): PositionEvent | null {
        const kind = id === w.positionStateId ? id === w.positionCommandId && state.ack === false ? 'target' : 'actual'
            : id === w.positionCommandId ? 'target' : id === w.movementStateId ? 'moving' : null;
        return kind ? { kind, position: normalizePosition(state.val, w), moving: state.val === true || state.val === 1,
            ts: state.ts, from: state.from, ack: state.ack } : null;
    }
    private expectedMotorFeedback(id: string, state: ioBroker.State | null | undefined): boolean {
        if (!this.initialized || !state || state.q) return false;
        const w = this.settings.windows.find(w => id === w.positionStateId || id === w.positionCommandId || id === w.movementStateId);
        if (!w) return false;
        const r = this.windows.get(w.id)!, command = r.ownCommand, now = Date.now();
        if (!command || now < command.issuedAt || now > command.expiresAt) { this.receivedFeedback.delete(w.id); return false; }
        const event = this.motorEvent(w, id, state)!;
        let received = this.receivedFeedback.get(w.id);
        if (!received || received.commandId !== command.id) {
            received = { commandId: command.id, runtime: structuredClone(r) };
            this.receivedFeedback.set(w.id, received);
        }
        // Classify synchronously so expected feedback cannot cancel sibling writes.
        // Track bursts in receive order: a reversal must still invalidate the plan
        // even while queued state processing is waiting for a database write.
        const active = received.runtime.ownCommand && event.ts >= command.issuedAt - 1000 &&
            event.ts >= received.runtime.lastObservedAt && event.ts <= now + MINUTE;
        const status = observe(received.runtime, event, this.settings, now, `system.adapter.${this.namespace}`);
        return status === 'own' || !!active && status === 'unchanged' && event.kind === 'moving' && (state.val === false || state.val === 0);
    }
    private async channel(id: string, name: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
    }
    private async object(id: string, value: ioBroker.StateValue, write = false, unit?: string): Promise<void> {
        const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' || value === null ? 'number' : 'string';
        await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: id.split('.').at(-1)!, type, read: true, write,
            role: type === 'boolean' ? (write ? 'switch.enable' : 'indicator') : type === 'number' ? 'value' : 'text', ...(unit ? { unit } : {}), def: value }, native: {} });
        if (!(await this.getStateAsync(id))) await this.setStateAsync(id, value, true);
    }
    private async publish(id: string, value: ioBroker.StateValue): Promise<void> { await this.setStateChangedAsync(id, value, true); }
    private async json(id: string): Promise<Record<string, any> | null> {
        const state = await this.getStateAsync(id);
        try { const v = JSON.parse(String(state?.val)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
        catch { return null; }
    }
    private async saveGlobal(): Promise<void> {
        await this.setStateAsync('global.runtime', JSON.stringify(this.controls), true);
        for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun'] as const) await this.publish(`global.${key}`, this.controls[key]);
    }
    private async saveWindow(id: string): Promise<void> { await this.setStateAsync(`windows.${id}.runtime`, JSON.stringify(this.windows.get(id)), true); }
    private async ready(): Promise<void> {
        let native: Record<string, any>;
        try { native = migrateLegacyConfig(this.config); this.settings = parseConfig(native); }
        catch (error) { this.log.error(`Invalid configuration; control remains inactive: ${error}`); return; }
        if (native !== this.config) {
            try {
                const id = `system.adapter.${this.namespace}`, instance = await this.getForeignObjectAsync(id);
                if (!instance || instance.type !== 'instance') throw new Error('Adapter instance object unavailable');
                // Re-read before migrating so unrelated recent Admin changes are preserved.
                const migrated = migrateLegacyConfig(instance.native);
                this.settings = parseConfig(migrated);
                if (migrated !== instance.native) {
                    await this.setForeignObjectAsync(id, { ...instance, native: migrated });
                    this.log.info('Migrated legacy settings: nested heating values and allowed automatic positions.');
                }
            } catch (error) { this.log.error(`Cannot migrate configuration; control remains inactive: ${error}`); return; }
            if (this.stopped) return;
        }
        const c = this.settings, now = Date.now(); this.startedAt = now;
        for (const id of ['global', 'info', 'rooms', 'windows']) await this.channel(id, id);
        await this.object('global.runtime', '{}');
        const storedGlobal = await this.json('global.runtime');
        this.controls = newGlobal(c, now);
        if (storedGlobal) {
            for (const key of ['disabledDate', 'day'] as const) if (typeof storedGlobal[key] === 'string') this.controls[key] = storedGlobal[key];
            if (typeof storedGlobal.modeChangedAt === 'number' && Number.isFinite(storedGlobal.modeChangedAt)) this.controls.modeChangedAt = storedGlobal.modeChangedAt;
        }
        for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun'] as const) {
            await this.object(`global.${key}`, this.controls[key], true);
            const s = await this.getStateAsync(`global.${key}`);
            if (typeof s?.val === 'boolean') this.controls[key] = s.val;
            if (key === 'disabledToday' && s?.val === true && (!s.ack || !this.controls.disabledDate)) this.controls.disabledDate = localDate(s.ts, c.timezone);
            if (key === 'vacationMode' && s && !s.ack) this.controls.modeChangedAt = s.ts;
        }
        for (const [key, value] of Object.entries({ operatingMode: 'STARTUP', forecastValid: false, lastForecastUpdate: 0, forecastError: '', lastEvaluation: 0, nextMorning: 0, nextEvening: 0 })) await this.object(`global.${key}`, value);
        await this.object('info.connection', false); await this.object('info.forecastCache', '{}');
        const cached = await this.json('info.forecastCache');
        if (cached?.location && forecastGrid(cached as unknown as Forecast, c, now)) this.forecast = cached as unknown as Forecast;
        for (const room of c.rooms) {
            await this.channel(`rooms.${room.id}`, room.name);
            await this.object(`rooms.${room.id}.runtime`, '{}');
            const stored = await this.json(`rooms.${room.id}.runtime`), r = newRoomRuntime();
            if (stored) {
                for (const key of ['residualPowerW', 'heatingUpdatedAt', 'limitUpdatedAt'] as const) if (typeof stored[key] === 'number' && Number.isFinite(stored[key]) && stored[key] >= 0) r[key] = stored[key];
                if (typeof stored.adaptiveLimit === 'number' && stored.adaptiveLimit >= room.targetTemperatureC && stored.adaptiveLimit <= room.targetTemperatureC + c.toleranceMaxC) r.adaptiveLimit = stored.adaptiveLimit;
                r.residualPowerW = Math.min(r.residualPowerW, room.heating.nominalPowerW * 2);
            }
            this.rooms.set(room.id, r);
            for (const [key, unit] of Object.entries({ currentTemperature: '°C', climateBudget24h: 'Wh', climateIndex: 'K', capacityWhK: 'Wh/K', timeConstantHours: 'h', solarPotential24h: 'Wh', solarAllowed24h: 'Wh', solarBudget24h: 'Wh', solarPowerTargetW: 'W', heatingEnergyPredicted24h: 'Wh', predictedMaxTemp: '°C', openMaxTemp: '°C', adaptiveTempLimit: '°C', residualHeatingPower: 'W' })) await this.object(`rooms.${room.id}.${key}`, null, false, unit);
            await this.object(`rooms.${room.id}.solarBudgetExceeded`, false);
            await this.object(`rooms.${room.id}.modelQuality`, 'UNAVAILABLE');
            await this.object(`rooms.${room.id}.unavoidableOverheating`, false);
            await this.object(`rooms.${room.id}.temperaturePlan`, '[]');
        }
        for (const w of c.windows) {
            const base = `windows.${w.id}`;
            await this.channel(base, w.name); await this.object(`${base}.runtime`, '{}');
            const stored = await this.json(`${base}.runtime`);
            const r = restoreWindow(stored, w, c, now);
            for (const key of ['enabled', 'autoMorningOpen'] as const) {
                await this.object(`${base}.${key}`, r[key], true);
                const s = await this.getStateAsync(`${base}.${key}`);
                if (typeof s?.val === 'boolean') r[key] = s.val;
                await this.publish(`${base}.${key}`, r[key]);
            }
            this.windows.set(w.id, r);
            await this.object(`${base}.directSun`, false);
            await this.object(`${base}.directIrradiance`, null, false, 'W/m²');
            for (const [key, value] of Object.entries({ participatingToday: false, manualOverrideActive: false, manualHoldUntil: 0, manualPositionLimit: null, manualPositionLimitActive: false, calculatedPosition: null, actualPosition: null, controlReason: 'STARTUP', lastOwnCommand: '', commandError: '' })) await this.object(`${base}.${key}`, value, false, key.endsWith('Position') || key === 'manualPositionLimit' ? '%' : undefined);
            if (r.lastPlannedPosition === null && r.day === localDate(now, c.timezone)) {
                const previousPlan = await this.getStateAsync(`${base}.calculatedPosition`);
                if (previousPlan && localDate(previousPlan.ts, c.timezone) === r.day) {
                    const value = freshNumber(previousPlan, now, c.forecastMaxAgeMinutes, 0, 100);
                    r.lastPlannedPosition = value !== null && stored && stored.positionConvention !== 'percentOpen' ? 100 - value : value;
                }
            }
        }
        rollover(this.controls, this.windows.values(), now, c);
        await this.saveGlobal();
        await this.subscribeStatesAsync('*');
        const inputIds = new Set([
            ...c.rooms.flatMap(r => [r.temperatureSensorId, r.heating.setpointId, r.heating.demandId, r.heating.valvePositionId]),
            ...c.windows.flatMap(w => [w.positionStateId, w.positionCommandId, w.movementStateId]),
            c.centralHeating.flowTemperatureId, c.centralHeating.returnTemperatureId,
        ].filter(Boolean));
        for (const id of inputIds) { await this.subscribeForeignStatesAsync(id); const state = await this.getForeignStateAsync(id); if (state) this.inputs.set(id, state); }
        for (const w of c.windows) {
            const r = this.windows.get(w.id)!; const s = this.inputs.get(w.positionStateId);
            if (s && this.position(w.id, now) !== null) {
                const observed = observe(r, { kind: 'actual', position: normalizePosition(s.val, w), ts: s.ts, from: s.from, ack: s.ack }, c, now, `system.adapter.${this.namespace}`);
                if (observed === 'manual') this.log.info(`${w.id}: offline position change, manual hold restored`);
            } else if (s && !s.q && s.ack === false && w.positionCommandId === w.positionStateId) {
                observe(r, { kind: 'target', position: normalizePosition(s.val, w), ts: s.ts, from: s.from, ack: false }, c, now, `system.adapter.${this.namespace}`);
            }
            await this.saveWindow(w.id);
        }
        this.initialized = true;
        this.tick = setInterval(() => this.enqueue(() => this.evaluate()), MINUTE);
        this.startup = setTimeout(() => this.enqueue(() => this.evaluate()), c.startupDelaySeconds * 1000);
        this.armMidnight();
        await this.evaluate();
        void this.refreshForecast();
        this.log.info(`Thermal blind control ready: ${c.rooms.length} rooms, ${c.windows.length} windows; ${c.thermalMode}, dry run ${this.controls.dryRun}`);
    }
    private armMidnight(): void {
        clearTimeout(this.midnight);
        this.midnight = setTimeout(() => { this.enqueue(async () => { await this.evaluate(); this.armMidnight(); }); }, nextMidnight(Date.now(), this.settings.timezone) - Date.now() + 50);
    }
    private async refreshForecast(): Promise<void> {
        if (this.stopped || this.forecastRunning || !this.settings.windows.length) return;
        this.forecastRunning = true;
        try {
            const forecast = await fetchForecast(this.settings);
            this.enqueue(async () => {
                this.forecast = forecast; this.dirty = true;
                await this.setStateAsync('info.forecastCache', JSON.stringify(forecast), true);
                await this.publish('global.forecastError', ''); await this.evaluate();
            });
        } catch (error) {
            this.enqueue(async () => { this.log.warn(`Forecast refresh failed: ${error}`); await this.publish('global.forecastError', String(error)); await this.evaluate(); });
        } finally {
            this.forecastRunning = false;
            if (!this.stopped) this.weatherTimer = setTimeout(() => void this.refreshForecast(), this.settings.forecastRefreshMinutes * MINUTE);
        }
    }
    private requestEvaluation(): void {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.enqueue(() => this.evaluate()), 100);
    }
    private async stateChanged(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.initialized) return;
        const c = this.settings, now = Date.now();
        rollover(this.controls, this.windows.values(), now, c);
        if (id.startsWith(`${this.namespace}.`)) {
            const key = id.slice(this.namespace.length + 1);
            if (!state || state.ack) return;
            const global = /^global\.(enabled|disabledToday|vacationMode|dryRun)$/.exec(key);
            const window = /^windows\.([a-zA-Z0-9_-]+)\.(enabled|autoMorningOpen)$/.exec(key);
            if (global) {
                const field = global[1] as 'enabled' | 'disabledToday' | 'vacationMode' | 'dryRun';
                if (typeof state.val !== 'boolean') { await this.setStateAsync(key, this.controls[field], true); return; }
                if (field === 'vacationMode' && this.controls.vacationMode !== state.val) this.controls.modeChangedAt = now;
                this.controls[field] = state.val;
                if (field === 'disabledToday') this.controls.disabledDate = state.val ? localDate(now, c.timezone) : '';
                await this.saveGlobal();
            } else if (window && this.windows.has(window[1])) {
                const runtime = this.windows.get(window[1])!, field = window[2] as 'enabled' | 'autoMorningOpen';
                if (typeof state.val === 'boolean') runtime[field] = state.val;
                await this.saveWindow(window[1]); await this.setStateAsync(key, runtime[field], true);
            } else return;
        } else {
            const previous = this.inputs.get(id);
            if (state && previous && state.ts < previous.ts) return;
            // A shared state's unacknowledged target is not actual motor feedback.
            const sharedTarget = state?.ack === false && c.windows.some(w => w.positionCommandId === id && w.positionStateId === id);
            if (state && !sharedTarget) this.inputs.set(id, state); else if (!state) this.inputs.delete(id);
            if (state && !state.q) for (const w of c.windows) {
                const r = this.windows.get(w.id)!;
                const event = this.motorEvent(w, id, state);
                if (!event) continue;
                const status = observe(r, event, c, now, `system.adapter.${this.namespace}`);
                if (status === 'manual') this.log.info(`${w.id}: foreign ${event.kind} event; manual hold until ${new Date(r.manualHoldUntil).toISOString()}`);
                await this.saveWindow(w.id);
            }
        }
        this.dirty = true; this.requestEvaluation();
    }
    private position(id: string, now: number): number | null {
        const w = this.settings.windows.find(w => w.id === id)!;
        if (w.positionStateId === w.positionCommandId && this.inputs.get(w.positionStateId)?.ack === false) return null;
        const raw = freshNumber(this.inputs.get(w.positionStateId), now, this.settings.positionMaxAgeMinutes,
            Math.min(w.deviceOpenValue, w.deviceClosedValue), Math.max(w.deviceOpenValue, w.deviceClosedValue));
        return raw === null ? null : normalizePosition(raw, w);
    }
    private roomTemperature(room: RoomConfig, now: number): number | null { return freshNumber(this.inputs.get(room.temperatureSensorId), now, this.settings.sensorMaxAgeMinutes, -10, 55); }
    private heating(room: RoomConfig, now: number): HeatingObservation {
        const c = this.settings;
        const number = (id: string, min: number, max: number): number | null => freshNumber(this.inputs.get(id), now, c.sensorMaxAgeMinutes, min, max);
        const demand = this.inputs.get(room.heating.demandId);
        const demandFresh = demand && !demand.q && Number.isFinite(demand.ts) && demand.ts <= now + MINUTE && now - demand.ts <= c.sensorMaxAgeMinutes * MINUTE;
        return { setpointC: number(room.heating.setpointId, 5, 35), valvePercent: number(room.heating.valvePositionId, 0, 100),
            demand: demandFresh && [true, false, 0, 1].includes(demand.val as any) ? Boolean(demand.val) : null,
            flowC: number(c.centralHeating.flowTemperatureId, 0, 100), returnC: number(c.centralHeating.returnTemperatureId, 0, 100) };
    }
    private async evaluate(): Promise<void> {
        if (!this.initialized || this.stopped) return;
        const now = Date.now(), c = this.settings, revision = this.revision;
        const dayChanged = rollover(this.controls, this.windows.values(), now, c);
        await this.saveGlobal();
        const grid = forecastGrid(this.forecast, c, now);
        const startupReady = now - this.startedAt >= c.startupDelaySeconds * 1000;
        if (!grid) this.results.clear();
        if (grid && (this.dirty || now >= this.planValidUntil || now - this.lastOptimization >= c.optimizationIntervalMinutes * MINUTE)) {
            this.results.clear();
            let planValidUntil = Infinity;
            for (const room of c.rooms) {
                const temperature = this.roomTemperature(room, now);
                const windows = c.windows.filter(w => w.roomId === room.id);
                if (temperature === null || windows.some(w => this.position(w.id, now) === null)) continue;
                const runtime = this.rooms.get(room.id)!;
                const heating = this.heating(room, now);
                updateHeating(room, heating, temperature, runtime, now);
                const models = windows.map(w => {
                    const r = this.windows.get(w.id)!;
                    const actual = this.position(w.id, now)!, position = positionForForecast(r, actual, now);
                    if (position !== actual) planValidUntil = Math.min(planValidUntil, r.ownCommand!.expiresAt);
                    return { config: w, position, lastMoveAt: r.lastAutoAt,
                        maximumPosition: dailyManualPositionLimit(r, c, now) ?? 100, maximumPositionUntil: nextMidnight(now, c.timezone),
                        movableAfter: this.controls.vacationMode || r.enabled && r.participatingToday ? Math.max(now, r.manualHoldUntil) : Infinity };
                });
                const result = optimizeRoom(room, models, grid, temperature, heating, runtime, c, now);
                this.results.set(room.id, result);
                await this.setStateAsync(`rooms.${room.id}.runtime`, JSON.stringify(runtime), true);
            }
            this.dirty = false; this.lastOptimization = now; this.planValidUntil = planValidUntil;
        }
        const times = schedule(now, c);
        const mode = !this.controls.enabled ? 'DISABLED' : this.controls.disabledToday ? 'DISABLED_TODAY' : this.controls.vacationMode ? 'VACATION' : !grid ? 'FORECAST_INVALID' : this.controls.dryRun ? 'DRY_RUN' : c.thermalMode.toUpperCase();
        for (const [key, value] of Object.entries({ operatingMode: mode, forecastValid: !!grid, lastForecastUpdate: this.forecast?.fetchedAt ?? 0, lastEvaluation: now, nextMorning: times.morning, nextEvening: times.evening })) await this.publish(`global.${key}`, value);
        await this.publish('info.connection', !!grid);
        for (const room of c.rooms) {
            let result = this.results.get(room.id);
            const currentTemperature = this.roomTemperature(room, now);
            if (currentTemperature === null || c.windows.some(w => w.roomId === room.id && this.position(w.id, now) === null)) { result = undefined; this.results.delete(room.id); }
            const base = `rooms.${room.id}`;
            await this.publish(`${base}.currentTemperature`, currentTemperature);
            for (const key of ['climateBudget24h', 'climateIndex', 'capacityWhK', 'timeConstantHours', 'solarPotential24h', 'solarAllowed24h', 'solarBudget24h', 'solarPowerTargetW', 'heatingEnergyPredicted24h', 'predictedMaxTemp', 'openMaxTemp', 'adaptiveTempLimit'] as const) await this.publish(`${base}.${key}`, result?.[key] ?? null);
            await this.publish(`${base}.solarBudgetExceeded`, result?.solarBudgetExceeded ?? false);
            await this.publish(`${base}.residualHeatingPower`, this.rooms.get(room.id)!.residualPowerW);
            await this.publish(`${base}.modelQuality`, result?.modelQuality ?? 'UNAVAILABLE');
            await this.publish(`${base}.unavoidableOverheating`, result?.unavoidableOverheating ?? false);
            await this.publish(`${base}.temperaturePlan`, JSON.stringify(result?.plan ?? []));
        }
        for (const w of c.windows) {
            const r = this.windows.get(w.id)!, result = this.results.get(w.roomId), base = `windows.${w.id}`;
            const position = this.position(w.id, now), target = result?.targets[w.id] ?? null;
            const input = { config: c, global: this.controls, runtime: r, now, actualPosition: position, thermalTarget: target,
                forecastValid: !!grid, roomValid: !!result, startupReady, dayChanged, directSun: !!grid && hasDirectSun(grid[0], w.azimuthDeg, c, now),
                minimumThermalPosition: grid ? minimumThermalPosition(grid[0].gti[orientationKey(w.azimuthDeg)] * w.glassAreaM2 * w.gValue, c.minimumSolarPowerPerWindowW) : 0 };
            let decision = decide(input);
            // Keep the pre-manual plan while feedback is arriving: a held/intermediate
            // position is not a new automatic plan against which to classify the same move.
            if (r.manualHoldUntil <= now) r.lastPlannedPosition = decision.calculatedPosition;
            await this.publish(`${base}.actualPosition`, position); await this.publish(`${base}.calculatedPosition`, decision.calculatedPosition);
            await this.publish(`${base}.directSun`, input.directSun);
            await this.publish(`${base}.directIrradiance`, grid ? directIrradiance(grid[0], w.azimuthDeg, c, now) : null);
            if (decision.target !== null) {
                if (revision !== this.revision || this.stopped) decision = { ...decision, target: null, reason: 'INPUT_CHANGED' };
                else {
                    const before = structuredClone(r);
                    r.actualPosition = position;
                    beginCommand(r, w, decision.target, decision.reason, now, randomUUID());
                    // Persist intent before touching hardware. The revision check is repeated after the awaited write.
                    await this.saveWindow(w.id);
                    if (revision !== this.revision || this.stopped) {
                        Object.assign(r, before); await this.saveWindow(w.id);
                        decision = { ...decision, target: null, reason: 'INPUT_CHANGED' };
                    } else {
                        try {
                            await this.setForeignStateAsync(w.positionCommandId, devicePosition(decision.target, w), false);
                            completeEvent(r, decision.event, now, c); this.dirty = true;
                            await this.publish(`${base}.commandError`, '');
                            this.log.info(`${w.id}: ${decision.reason}, openness ${position}% -> ${decision.target}%, forecast=${this.forecast?.fetchedAt ?? 0}, predictedMax=${result?.predictedMaxTemp.toFixed(2) ?? 'n/a'}, manualHoldUntil=${r.manualHoldUntil}, command=${r.ownCommand!.id}`);
                        } catch (error) {
                            // Delivery may have occurred even when the database call fails: retain the durable cooldown and identity.
                            decision = { ...decision, reason: 'COMMAND_FAILED' };
                            await this.publish(`${base}.commandError`, String(error)); this.log.error(`${w.id}: command failed: ${error}`);
                        }
                    }
                }
            } else if (decision.event && (decision.reason === 'NO_CHANGE' || decision.reason === 'MANUAL_POSITION_LIMIT') && revision === this.revision) {
                completeEvent(r, decision.event, now, c); this.dirty = true;
            }
            await this.saveWindow(w.id);
            await this.publish(`${base}.lastOwnCommand`, r.ownCommand ? JSON.stringify(r.ownCommand) : '');
            await this.publish(`${base}.participatingToday`, r.participatingToday);
            await this.publish(`${base}.manualOverrideActive`, r.manualHoldUntil > now);
            await this.publish(`${base}.manualHoldUntil`, r.manualHoldUntil);
            const manualLimit = dailyManualPositionLimit(r, c, now);
            await this.publish(`${base}.manualPositionLimit`, manualLimit);
            await this.publish(`${base}.manualPositionLimitActive`, manualLimit !== null);
            await this.publish(`${base}.controlReason`, decision.reason);
        }
    }
}
if (require.main !== module) module.exports = (options: Partial<AdapterOptions> | undefined) => new ThermalBlindControl(options);
else new ThermalBlindControl();
