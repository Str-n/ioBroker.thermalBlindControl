import type { Config, WindowConfig } from './config';
import { localDate, MINUTE, schedule } from './time';
export interface OwnCommand {
    id: string; target: number; startPosition: number; issuedAt: number; expiresAt: number;
    lastFeedback: number; completed: boolean; reason: string;
}
export interface WindowRuntime {
    positionConvention: 'percentOpen';
    day: string; enabled: boolean; autoMorningOpen: boolean; participatingToday: boolean;
    manualHoldUntil: number; lastManualAt: number; lastAutoAt: number; lastObservedAt: number;
    actualPosition: number | null; observationAnchor: number | null; ownCommand: OwnCommand | null;
    morningDate: string; vacationMorningDate: string; vacationEveningDate: string;
}
export interface GlobalRuntime {
    enabled: boolean; disabledToday: boolean; vacationMode: boolean; dryRun: boolean;
    disabledDate: string; day: string; modeChangedAt: number;
}
export const newGlobal = (c: Config, now: number): GlobalRuntime => ({ enabled: c.enabled, disabledToday: c.disabledToday, vacationMode: c.vacationMode, dryRun: c.dryRun,
    disabledDate: c.disabledToday ? localDate(now, c.timezone) : '', day: localDate(now, c.timezone), modeChangedAt: now });
export const newWindow = (w: WindowConfig, c: Config, now: number): WindowRuntime => ({ positionConvention: 'percentOpen', day: localDate(now, c.timezone), enabled: w.enabled, autoMorningOpen: w.autoMorningOpen,
    participatingToday: false, manualHoldUntil: 0, lastManualAt: 0, lastAutoAt: 0, lastObservedAt: 0, actualPosition: null, observationAnchor: null, ownCommand: null,
    morningDate: '', vacationMorningDate: '', vacationEveningDate: '' });
export function restoreWindow(raw: unknown, w: WindowConfig, c: Config, now: number): WindowRuntime {
    const result = newWindow(w, c, now);
    if (!raw || typeof raw !== 'object') return result;
    const value = raw as Record<string, unknown>;
    for (const key of Object.keys(result) as (keyof WindowRuntime)[]) {
        if (key === 'positionConvention') continue;
        const v = value[key];
        if (typeof result[key] === 'boolean' && typeof v === 'boolean') (result as any)[key] = v;
        if (typeof result[key] === 'number' && typeof v === 'number' && Number.isFinite(v) && v >= 0) (result as any)[key] = v;
        if (typeof result[key] === 'string' && typeof v === 'string' && (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v))) (result as any)[key] = v;
    }
    if (typeof value.actualPosition === 'number' && value.actualPosition >= 0 && value.actualPosition <= 100) result.actualPosition = value.actualPosition;
    result.observationAnchor = typeof value.observationAnchor === 'number' && value.observationAnchor >= 0 && value.observationAnchor <= 100 ? value.observationAnchor : result.actualPosition;
    const command = value.ownCommand as OwnCommand | undefined;
    if (command && typeof command.id === 'string' && typeof command.reason === 'string' && typeof command.completed === 'boolean' &&
        [command.target, command.startPosition, command.lastFeedback].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) &&
        [command.issuedAt, command.expiresAt].every(v => Number.isFinite(v) && v >= 0) && command.expiresAt >= command.issuedAt && command.expiresAt - command.issuedAt <= 16 * MINUTE) result.ownCommand = { ...command };
    if (value.positionConvention !== 'percentOpen') {
        // Earlier versions persisted percent-closed positions without a convention marker.
        if (result.actualPosition !== null) result.actualPosition = 100 - result.actualPosition;
        if (result.observationAnchor !== null) result.observationAnchor = 100 - result.observationAnchor;
        if (result.ownCommand) {
            for (const key of ['target', 'startPosition', 'lastFeedback'] as const) result.ownCommand[key] = 100 - result.ownCommand[key];
        }
    }
    return result;
}
export function rollover(global: GlobalRuntime, windows: Iterable<WindowRuntime>, now: number, c: Config): boolean {
    const day = localDate(now, c.timezone), changed = global.day !== day;
    global.day = day;
    if (global.disabledToday && global.disabledDate !== day) { global.disabledToday = false; global.disabledDate = ''; }
    for (const w of windows) if (w.day !== day) { w.day = day; w.participatingToday = false; }
    return changed;
}
export function manualAction(runtime: WindowRuntime, openness: number | null, now: number, c: Config): void {
    runtime.manualHoldUntil = now + c.manualOverrideMinutes * MINUTE;
    runtime.lastManualAt = now; runtime.ownCommand = null;
    if (openness !== null && openness >= c.firstOpenPercent) runtime.participatingToday = true;
}
export interface PositionEvent { kind: 'actual' | 'target' | 'moving'; position?: number | null; moving?: boolean; ts: number; ack?: boolean; from?: string }
export function observe(runtime: WindowRuntime, event: PositionEvent, c: Config, now: number, ownSource: string): 'own' | 'manual' | 'unchanged' {
    if (!Number.isFinite(event.ts) || event.ts < runtime.lastObservedAt || event.ts > now + MINUTE) return 'unchanged';
    const command = runtime.ownCommand;
    const active = command && event.ts >= command.issuedAt - 1000 && now <= command.expiresAt;
    if (event.kind === 'moving') {
        if (!event.moving) return 'unchanged';
        if (active && !command.completed) return 'own';
        manualAction(runtime, null, now, c); return 'manual';
    }
    const position = event.position;
    if (position === null || position === undefined) return 'unchanged';
    const previous = runtime.actualPosition;
    const explicitExternal = event.kind === 'target' && event.ack === false && event.from !== ownSource;
    let own = false;
    if (active && !explicitExternal) {
        if (event.kind === 'target') own = Math.abs(position - command.target) <= c.positionTolerance;
        else {
            const direction = Math.sign(command.target - command.startPosition);
            const inRange = position >= Math.min(command.startPosition, command.target) - c.positionTolerance && position <= Math.max(command.startPosition, command.target) + c.positionTolerance;
            const progresses = direction * (position - command.lastFeedback) >= -c.positionTolerance;
            own = command.completed ? Math.abs(position - command.target) <= c.positionTolerance : inRange && progresses;
            if (own) {
                // Remember furthest progress: a small-step reversal must not hide inside the noise tolerance.
                if (direction * (position - command.lastFeedback) > 0) command.lastFeedback = position;
                if (Math.abs(position - command.target) <= c.positionTolerance) command.completed = true;
            }
        }
    }
    if (event.kind === 'actual') { runtime.actualPosition = position; runtime.lastObservedAt = event.ts; }
    if (own) { if (event.kind === 'actual') runtime.observationAnchor = position; return 'own'; }
    const anchor = runtime.observationAnchor ?? previous;
    const crossesOpen = previous !== null && previous < c.firstOpenPercent && position >= c.firstOpenPercent && runtime.manualHoldUntil > now;
    const changed = event.kind === 'target' || !!active || (anchor !== null && Math.abs(position - anchor) > c.positionTolerance) || crossesOpen;
    if (changed) {
        if (event.kind === 'actual') runtime.observationAnchor = position;
        manualAction(runtime, event.kind === 'actual' ? position : null, now, c); return 'manual';
    }
    if (event.kind === 'actual' && runtime.observationAnchor === null) runtime.observationAnchor = position;
    // Enrollment requires an observed external opening, not an already-open startup snapshot or a requested target.
    return 'unchanged';
}
export interface Decision { target: number | null; calculatedPosition: number | null; reason: string; event?: 'morning' | 'vacationMorning' | 'vacationEvening' }
export interface DecisionInput {
    config: Config; global: GlobalRuntime; runtime: WindowRuntime; now: number;
    actualPosition: number | null; thermalTarget: number | null; forecastValid: boolean; roomValid: boolean;
    startupReady: boolean; dayChanged?: boolean; directSun: boolean; minimumThermalPosition?: number;
}
export function decide(input: DecisionInput): Decision {
    const { config: c, global: g, runtime: r, now, actualPosition: position } = input;
    // Recheck at execution time: a cached thermal target must never close a facade after the sun has left it.
    const minimumPosition = input.minimumThermalPosition ?? 0;
    const thermalTarget = input.thermalTarget === null ? null : input.directSun ? Math.max(input.thermalTarget, minimumPosition) : 100;
    const result = (reason: string, target: number | null = null, event?: Decision['event']): Decision => ({ reason, target, event, calculatedPosition: thermalTarget });
    if (!g.enabled) return result('SYSTEM_DISABLED');
    if (g.disabledToday) return result('DISABLED_TODAY');
    if (r.manualHoldUntil > now) return result('MANUAL_LOCK');
    if (!input.startupReady) return result('STARTUP_DELAY');
    if (input.dayChanged) return result('DAY_RESET');
    if (position === null) return result('POSITION_INVALID');
    const times = schedule(now, c), day = localDate(now, c.timezone);
    const due = (time: number): boolean => now >= time && now < time + c.scheduleCatchUpMinutes * MINUTE && time >= g.modeChangedAt;
    let target: number | null = null, reason = 'NO_CHANGE', event: Decision['event'];
    let daylightOpening = false;
    if (g.vacationMode) {
        if (due(times.evening) && r.vacationEveningDate !== day) { target = 0; reason = 'VACATION_CLOSE'; event = 'vacationEvening'; }
        else if (due(times.morning) && r.vacationMorningDate !== day) { target = 100; reason = 'VACATION_OPEN'; event = 'vacationMorning'; }
        else return result('VACATION_WAIT');
    } else {
        if (!r.enabled) return result('WINDOW_DISABLED');
        if (!r.autoMorningOpen && !r.participatingToday) return result('WAIT_FIRST_OPEN');
        if (r.autoMorningOpen && r.morningDate !== day && !r.participatingToday && due(times.morning)) { target = 100; reason = 'MORNING_OPEN'; event = 'morning'; }
        else {
            if (!r.participatingToday) return result('WAIT_MORNING');
            if (now < times.morning || now >= times.evening) return result('OUTSIDE_CONTROL_HOURS');
            if (!input.forecastValid) return result('FORECAST_INVALID');
            if (!input.roomValid) return result('ROOM_INVALID');
            if (c.thermalMode === 'off') return result('THERMAL_OFF');
            if (thermalTarget === null) return result('MODEL_UNAVAILABLE');
            if (c.thermalMode === 'shadow') return result('SHADOW_MODE');
            target = thermalTarget;
            daylightOpening = input.directSun && position < minimumPosition && target > position;
            reason = daylightOpening ? 'DAYLIGHT_MINIMUM' : !input.directSun ? 'NO_DIRECT_SUN' : target < position ? 'THERMAL_PROTECTION' : 'SOLAR_GAIN';
        }
    }
    if (Math.abs(target - position) < c.minPositionChange) return result('NO_CHANGE', null, event);
    if (r.ownCommand && !r.ownCommand.completed && now < r.ownCommand.expiresAt) return result('MOVING');
    if (r.lastAutoAt && now - r.lastAutoAt < c.minMovementIntervalMinutes * MINUTE) return result('MOVEMENT_COOLDOWN');
    if (g.dryRun) return result('DRY_RUN', null);
    return result(reason, target, event);
}
export function completeEvent(r: WindowRuntime, event: Decision['event'], now: number, c: Config): void {
    const day = localDate(now, c.timezone);
    if (event === 'morning') { r.morningDate = day; r.participatingToday = true; }
    if (event === 'vacationMorning') r.vacationMorningDate = day;
    if (event === 'vacationEvening') r.vacationEveningDate = day;
}
export function beginCommand(r: WindowRuntime, w: WindowConfig, target: number, reason: string, now: number, id: string): void {
    r.ownCommand = { id, target, reason, startPosition: r.actualPosition!, issuedAt: now, expiresAt: now + w.travelSeconds * 1000,
        lastFeedback: r.actualPosition!, completed: false };
    r.lastAutoAt = now;
}
