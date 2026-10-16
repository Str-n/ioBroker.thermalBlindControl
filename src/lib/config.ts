export type Construction = 'veryLight' | 'light' | 'medium' | 'heavy' | 'veryHeavy';
export const capacities: Record<Construction, number> = { veryLight: 22, light: 31, medium: 46, heavy: 72, veryHeavy: 103 };
export interface HeatingConfig {
    type: 'none' | 'radiator' | 'underfloor';
    setpointId: string;
    demandId: string;
    valvePositionId: string;
    nominalPowerW: number;
    residualTimeHours: number;
}
export interface RoomConfig {
    id: string; name: string; temperatureSensorId: string;
    targetTemperatureC: number; heatLossWK: number; floorAreaM2: number;
    construction: Construction; internalGainsW: number; heating: HeatingConfig;
}
export interface WindowConfig {
    id: string; name: string; roomId: string;
    azimuthDeg: number; tiltDeg: number; glassAreaM2: number; gValue: number;
    closedTransmission: number; enabled: boolean; autoMorningOpen: boolean;
    positionStateId: string; positionCommandId: string; movementStateId: string;
    deviceOpenValue: number; deviceClosedValue: number; travelSeconds: number;
}
export interface Config {
    enabled: boolean; disabledToday: boolean; vacationMode: boolean; dryRun: boolean; thermalMode: 'off' | 'shadow' | 'active';
    latitude: number; longitude: number; timezone: string;
    optimizationIntervalMinutes: number; forecastRefreshMinutes: number; forecastMaxAgeMinutes: number;
    sensorMaxAgeMinutes: number; positionMaxAgeMinutes: number; startupDelaySeconds: number;
    manualOverrideMinutes: number; minMovementIntervalMinutes: number; allowedPositions: number[]; positionTolerance: number;
    minimumSolarPowerPerWindowW: number;
    respectManualPositionUntilEndOfDay: boolean;
    firstOpenPercent: number; morningEarliest: string; morningLatest: string; morningOffsetMinutes: number;
    eveningEarliest: string; eveningLatest: string; eveningOffsetMinutes: number; scheduleCatchUpMinutes: number;
    toleranceMaxC: number; toleranceStartK: number; toleranceFullK: number; limitSmoothingMinutes: number;
    centralHeating: { flowTemperatureId: string; returnTemperatureId: string };
    rooms: RoomConfig[]; windows: WindowConfig[];
}
export const heatingDefaults: HeatingConfig = { type: 'none', setpointId: '', demandId: '', valvePositionId: '', nominalPowerW: 1000, residualTimeHours: 3 };
export const roomDefaults: RoomConfig = { id: '', name: '', temperatureSensorId: '', targetTemperatureC: 21, heatLossWK: 80, floorAreaM2: 25, construction: 'medium', internalGainsW: 0, heating: heatingDefaults };
export const windowDefaults: WindowConfig = {
    id: '', name: '', roomId: '', azimuthDeg: 180, tiltDeg: 90, glassAreaM2: 3, gValue: 0.5,
    closedTransmission: 0.05, enabled: true, autoMorningOpen: true,
    positionStateId: '', positionCommandId: '', movementStateId: '', deviceOpenValue: 100, deviceClosedValue: 0, travelSeconds: 120,
};
export const defaults: Config = {
    enabled: false, disabledToday: false, vacationMode: false, dryRun: true, thermalMode: 'shadow',
    latitude: 50.47, longitude: 7.47, timezone: 'Europe/Berlin',
    optimizationIntervalMinutes: 15, forecastRefreshMinutes: 60, forecastMaxAgeMinutes: 180,
    sensorMaxAgeMinutes: 180, positionMaxAgeMinutes: 10080, startupDelaySeconds: 30,
    manualOverrideMinutes: 60, minMovementIntervalMinutes: 15, allowedPositions: [100, 80, 60, 40, 20, 10, 0], positionTolerance: 3,
    minimumSolarPowerPerWindowW: 0,
    respectManualPositionUntilEndOfDay: false,
    firstOpenPercent: 90, morningEarliest: '07:00', morningLatest: '10:00', morningOffsetMinutes: 0,
    eveningEarliest: '17:00', eveningLatest: '22:00', eveningOffsetMinutes: 0, scheduleCatchUpMinutes: 60,
    toleranceMaxC: 4, toleranceStartK: 1, toleranceFullK: 8, limitSmoothingMinutes: 60,
    centralHeating: { flowTemperatureId: '', returnTemperatureId: '' }, rooms: [], windows: [],
};
function object(v: unknown): Record<string, any> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected configuration object');
    return v as Record<string, any>;
}
function number(v: unknown, name: string, min: number, max: number): number {
    if (v === '' || v === null || typeof v === 'boolean' || !Number.isFinite(Number(v)) || Number(v) < min || Number(v) > max)
        throw new Error(`${name} must be between ${min} and ${max}`);
    return Number(v);
}
function id(v: unknown, name: string): string {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(v) || ['__proto__', 'constructor', 'prototype'].includes(v))
        throw new Error(`${name} needs a stable ID using letters, numbers, _ or -`);
    return v;
}
function stateId(v: unknown, name: string, required = false): string {
    if (typeof v !== 'string' || (required && !v.trim()) || /[\s*]/.test(v)) throw new Error(`Invalid ${name}`);
    return v;
}
// Kept self-contained so the Admin generator can use the same normalization in
// its accordion callback. Mutate the row there so rendering and export agree.
export function normalizeDottedFields(data: Record<string, any>, property: string, keys: readonly string[]): boolean {
    let changed = false;
    for (const key of keys) {
        const attr = `${property}.${key}`;
        if (!Object.prototype.hasOwnProperty.call(data, attr)) continue;
        if (!changed) data[property] = { ...data[property] };
        data[property][key] = data[attr];
        delete data[attr];
        changed = true;
    }
    return changed;
}
export function migrateLegacyConfig(raw: unknown): Record<string, any> {
    const original = object(raw), input = { ...original };
    let changed = normalizeDottedFields(input, 'centralHeating', Object.keys(defaults.centralHeating));
    if (Array.isArray(input.rooms)) {
        input.rooms = input.rooms.map(value => {
            const room = { ...object(value) };
            if (!normalizeDottedFields(room, 'heating', Object.keys(heatingDefaults))) return value;
            changed = true;
            return room;
        });
    }
    if (Object.hasOwn(input, 'minPositionChange')) { delete input.minPositionChange; changed = true; }
    if (input.global && Object.hasOwn(object(input.global), 'minPositionChange')) {
        input.global = { ...input.global };
        delete input.global.minPositionChange;
        changed = true;
    }
    if (changed && input.allowedPositions === undefined && input.global?.allowedPositions === undefined)
        input.allowedPositions = [...defaults.allowedPositions];
    return changed ? input : original;
}
export function parseConfig(raw: unknown): Config {
    const input = migrateLegacyConfig(raw);
    const c: Config = { ...structuredClone(defaults), ...input, ...(input.global ? object(input.global) : {}),
        centralHeating: { ...defaults.centralHeating, ...input.centralHeating } };
    for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun', 'respectManualPositionUntilEndOfDay'] as const)
        if (typeof c[key] !== 'boolean') throw new Error(`${key} must be boolean`);
    if (!['off', 'shadow', 'active'].includes(c.thermalMode)) throw new Error('Invalid thermalMode');
    new Intl.DateTimeFormat('en', { timeZone: c.timezone }).format();
    const ranges: Partial<Record<keyof Config, [number, number]>> = {
        latitude: [-89, 89], longitude: [-180, 180], optimizationIntervalMinutes: [1, 60], forecastRefreshMinutes: [15, 1440],
        forecastMaxAgeMinutes: [30, 1440], sensorMaxAgeMinutes: [1, 43200], positionMaxAgeMinutes: [1, 43200],
        startupDelaySeconds: [0, 3600], manualOverrideMinutes: [60, 1440], minMovementIntervalMinutes: [15, 1440],
        positionTolerance: [0.1, 10], firstOpenPercent: [50, 100],
        minimumSolarPowerPerWindowW: [0, 10000],
        morningOffsetMinutes: [-180, 180], eveningOffsetMinutes: [-180, 180], scheduleCatchUpMinutes: [1, 180],
        toleranceMaxC: [0, 10], toleranceStartK: [-10, 20], toleranceFullK: [-9, 30], limitSmoothingMinutes: [0, 1440],
    };
    for (const [key, range] of Object.entries(ranges)) (c as any)[key] = number((c as any)[key], key, range[0], range[1]);
    if (!Array.isArray(c.allowedPositions)) throw new Error('allowedPositions must be an array of percentages');
    c.allowedPositions = [...new Set(c.allowedPositions.map((value: unknown) => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
            throw new Error('allowedPositions must contain numeric percentages');
        return number(value, 'allowedPositions', 0, 100);
    }))].sort((a, b) => b - a);
    if (c.allowedPositions[0] !== 100 || c.allowedPositions.at(-1) !== 0)
        throw new Error('allowedPositions must include 100 (fully open) and 0 (fully closed)');
    if (c.toleranceFullK <= c.toleranceStartK) throw new Error('toleranceFullK must exceed toleranceStartK');
    for (const key of ['morningEarliest', 'morningLatest', 'eveningEarliest', 'eveningLatest'] as const)
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[key])) throw new Error(`Invalid ${key}`);
    if (!(c.morningEarliest <= c.morningLatest && c.morningLatest < c.eveningEarliest && c.eveningEarliest <= c.eveningLatest))
        throw new Error('Morning and evening schedule bounds must be ordered and not overlap');
    if (!Array.isArray(c.rooms) || !Array.isArray(c.windows) || c.rooms.length > 32 || c.windows.length > 64) throw new Error('Expected up to 32 rooms and 64 windows');
    c.rooms = c.rooms.map((value) => {
        const r = { ...roomDefaults, ...object(value), heating: { ...heatingDefaults, ...value.heating } } as RoomConfig;
        r.id = id(r.id, 'room.id'); r.name ||= r.id;
        r.temperatureSensorId = stateId(r.temperatureSensorId, 'temperatureSensorId', true);
        for (const [key, min, max] of [['targetTemperatureC', 10, 30], ['heatLossWK', 1, 2000], ['floorAreaM2', 1, 1000], ['internalGainsW', 0, 10000]] as const)
            r[key] = number(r[key], key, min, max);
        if (!Object.hasOwn(capacities, r.construction)) throw new Error('Invalid construction class');
        if (!['none', 'radiator', 'underfloor'].includes(r.heating.type)) throw new Error('Invalid heating type');
        for (const key of ['setpointId', 'demandId', 'valvePositionId'] as const) stateId(r.heating[key], key);
        r.heating.nominalPowerW = number(r.heating.nominalPowerW, 'nominalPowerW', 0, 20000);
        r.heating.residualTimeHours = number(r.heating.residualTimeHours, 'residualTimeHours', 0.25, 24);
        return r;
    });
    c.windows = c.windows.map((value) => {
        const v = object(value);
        const legacyPolarity = v.openIsPercent === undefined ? {} : { deviceOpenValue: v.openIsPercent, deviceClosedValue: 100 - v.openIsPercent };
        const w = { ...windowDefaults, ...legacyPolarity, ...v } as WindowConfig;
        w.id = id(w.id, 'window.id'); w.name ||= w.id;
        if (!c.rooms.some(r => r.id === w.roomId)) throw new Error(`Unknown room ${w.roomId}`);
        for (const key of ['enabled', 'autoMorningOpen'] as const) if (typeof w[key] !== 'boolean') throw new Error(`${key} must be boolean`);
        for (const [key, min, max] of [['azimuthDeg', 0, 360], ['tiltDeg', 90, 90], ['glassAreaM2', 0.01, 1000], ['gValue', 0.01, 1], ['closedTransmission', 0, 1], ['deviceOpenValue', -100000, 100000], ['deviceClosedValue', -100000, 100000], ['travelSeconds', 5, 900]] as const)
            w[key] = number(w[key], key, min, max);
        if (w.deviceOpenValue === w.deviceClosedValue) throw new Error('Device endpoints must differ');
        stateId(w.positionStateId, 'positionStateId', true); stateId(w.positionCommandId, 'positionCommandId', true); stateId(w.movementStateId, 'movementStateId');
        w.azimuthDeg %= 360;
        return w;
    });
    for (const list of [c.rooms, c.windows]) if (new Set(list.map(v => v.id)).size !== list.length) throw new Error('Duplicate room/window ID');
    const actuatorIds = c.windows.flatMap(w => [...new Set([w.positionStateId, w.positionCommandId, w.movementStateId].filter(Boolean))]);
    if (new Set(actuatorIds).size !== actuatorIds.length) throw new Error('Windows must have distinct actuator states');
    const readOnly = c.rooms.flatMap(r => [r.temperatureSensorId, r.heating.setpointId, r.heating.demandId, r.heating.valvePositionId]);
    for (const key of ['flowTemperatureId', 'returnTemperatureId'] as const) { stateId(c.centralHeating[key], key); readOnly.push(c.centralHeating[key]); }
    if (c.windows.some(w => readOnly.includes(w.positionCommandId))) throw new Error('A blind command must never target a temperature or heating input');
    if ([...readOnly, ...actuatorIds].some(v => /^thermalblindcontrol\.\d+\./.test(v))) throw new Error('Inputs and actuator IDs cannot refer to this adapter');
    return c;
}
export function normalizePosition(value: unknown, w: WindowConfig): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const result = 100 * (value - w.deviceClosedValue) / (w.deviceOpenValue - w.deviceClosedValue);
    return result < 0 || result > 100 ? null : Math.max(0, result);
}
export function devicePosition(openness: number, w: WindowConfig): number {
    return w.deviceClosedValue + openness / 100 * (w.deviceOpenValue - w.deviceClosedValue);
}
export function automaticPosition(target: number, allowedPositions: readonly number[], maximumPosition = 100): number {
    // Configuration normalizes the list from most open to most closed. Round up
    // before predicting heat or issuing commands, while keeping manual ceilings.
    const ceiling = allowedPositions.find(position => position <= maximumPosition)!;
    const requested = Math.max(0, Math.min(target, ceiling));
    for (let i = allowedPositions.length - 1; i >= 0; i--)
        if (allowedPositions[i] >= requested) return allowedPositions[i];
    return ceiling;
}
