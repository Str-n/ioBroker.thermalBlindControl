import { automaticPosition, capacities, type Config, type RoomConfig, type WindowConfig } from './config';
import { clamp, HOUR, MINUTE } from './time';
import { hasDirectSun, orientationKey, type ForecastInterval } from './weather';
export interface HeatingObservation { setpointC: number | null; demand: boolean | null; valvePercent: number | null; flowC: number | null; returnC: number | null }
export interface RoomRuntime { residualPowerW: number; heatingUpdatedAt: number; adaptiveLimit: number | null; limitUpdatedAt: number }
export const newRoomRuntime = (): RoomRuntime => ({ residualPowerW: 0, heatingUpdatedAt: 0, adaptiveLimit: null, limitUpdatedAt: 0 });
export interface ModelWindow {
    config: WindowConfig; position: number; movableAfter: number; lastMoveAt: number;
    maximumPosition?: number; maximumPositionUntil?: number;
}
export interface PlanStep {
    time: number; temperature: number; outsideC: number; solarW: number; heatingW: number;
    solarPotentialW: number; solarTargetW: number; directSun: Record<string, boolean>; positions: Record<string, number>;
}
export interface ThermalResult {
    climateBudget24h: number; climateIndex: number; capacityWhK: number; timeConstantHours: number;
    solarPotential24h: number; solarAllowed24h: number; heatingEnergyPredicted24h: number;
    solarBudget24h: number; solarPowerTargetW: number; solarBudgetExceeded: boolean;
    adaptiveTempLimit: number; predictedMaxTemp: number; openMaxTemp: number; unavoidableOverheating: boolean;
    modelQuality: string; targets: Record<string, number>; plan: PlanStep[]; openPlan: PlanStep[];
}
export const capacity = (room: RoomConfig): number => room.floorAreaM2 * capacities[room.construction];
export function rcStep(temperature: number, outside: number, powerW: number, heatLossWK: number, capacityWhK: number, hours: number): number {
    const equilibrium = outside + powerW / heatLossWK;
    return equilibrium + (temperature - equilibrium) * Math.exp(-heatLossWK / capacityWhK * hours);
}
export function transmission(w: WindowConfig, openness: number): number { return w.closedTransmission + (1 - w.closedTransmission) * clamp(openness / 100); }
export function minimumThermalPosition(potentialW: number, minimumW: number): number {
    if (minimumW <= 0) return 0;
    if (potentialW <= 0) return 100;
    const requiredOpening = Math.min(1, minimumW / potentialW);
    // Residual heat from a closed blind is not daylight. Reserve actual uncovered glazing instead.
    // Round toward more daylight so a one-percent position never drops below the configured watt allowance.
    return Math.ceil(100 * requiredOpening - 1e-7);
}
function waterFactor(observation: HeatingObservation, roomC: number, reference: number): number {
    if (observation.flowC === null) return 1;
    const waterC = observation.returnC === null ? observation.flowC : (observation.flowC + observation.returnC) / 2;
    return clamp((waterC - roomC) / reference, 0, 1.5);
}
function inputPower(room: RoomConfig, observation: HeatingObservation, temperature: number): number {
    if (room.heating.type === 'none' || observation.demand === false) return 0;
    const valve = observation.valvePercent === null ? (observation.demand === true ? 1 : 0) : Math.sqrt(clamp(observation.valvePercent / 100));
    const water = waterFactor(observation, temperature, room.heating.type === 'radiator' ? 50 : 15);
    return room.heating.nominalPowerW * valve * Math.pow(water, room.heating.type === 'radiator' ? 1.3 : 1);
}
export function updateHeating(room: RoomConfig, observation: HeatingObservation, temperature: number, runtime: RoomRuntime, now: number): void {
    if (room.heating.type !== 'underfloor') { runtime.residualPowerW = 0; runtime.heatingUpdatedAt = now; return; }
    const target = inputPower(room, observation, temperature);
    if (!runtime.heatingUpdatedAt) runtime.residualPowerW = target;
    else {
        const dt = Math.max(0, (now - runtime.heatingUpdatedAt) / HOUR);
        // No fresh history across an outage: decay the stored slab estimate, never assume all unseen hours were heated.
        const input = dt > 1 ? 0 : target;
        runtime.residualPowerW = input + (runtime.residualPowerW - input) * Math.exp(-dt / room.heating.residualTimeHours);
    }
    runtime.heatingUpdatedAt = now;
}
function heatStep(room: RoomConfig, observation: HeatingObservation, temperature: number, slab: number, hours: number): { power: number; slab: number } {
    const setpoint = observation.setpointC ?? room.targetTemperatureC;
    // The existing thermostat remains in charge. This is an explicitly uncertain response estimate.
    const thermostat = clamp((setpoint + 0.3 - temperature) / 0.8);
    const input = inputPower(room, observation, temperature) * thermostat;
    if (room.heating.type !== 'underfloor') return { power: input, slab: 0 };
    const tau = room.heating.residualTimeHours;
    const decay = Math.exp(-hours / tau);
    return { power: input + (slab - input) * tau / hours * (1 - decay), slab: input + (slab - input) * decay };
}
export function adaptiveLimit(room: RoomConfig, climateIndex: number, c: Config, runtime: RoomRuntime, now: number): number {
    const raw = room.targetTemperatureC + c.toleranceMaxC * clamp((climateIndex - c.toleranceStartK) / (c.toleranceFullK - c.toleranceStartK));
    const previous = runtime.adaptiveLimit;
    // Tightening is immediate; loosening is smoothed so a brief forecast change cannot grant a new heat budget.
    const alpha = c.limitSmoothingMinutes ? 1 - Math.exp(-Math.max(0, now - runtime.limitUpdatedAt) / (c.limitSmoothingMinutes * MINUTE)) : 1;
    runtime.adaptiveLimit = previous === null || raw < previous ? raw : previous + alpha * (raw - previous);
    runtime.adaptiveLimit = clamp(runtime.adaptiveLimit, room.targetTemperatureC, room.targetTemperatureC + c.toleranceMaxC);
    runtime.limitUpdatedAt = now;
    return runtime.adaptiveLimit;
}
interface Trajectory {
    plan: PlanStep[]; solarWh: number; heatWh: number; maxTemp: number; comfortFeasible: boolean;
}
export function optimizeRoom(room: RoomConfig, windows: ModelWindow[], grid: ForecastInterval[], temperature: number,
    heating: HeatingObservation, runtime: RoomRuntime, c: Config, now: number): ThermalResult {
    const C = capacity(room);
    const budget = grid.reduce((sum, p) => sum + room.heatLossWK * (room.targetTemperatureC - p.outsideC) * (p.end - p.start) / HOUR, 0);
    const K = budget / (24 * room.heatLossWK);
    const limit = adaptiveLimit(room, K, c, runtime, now);
    const intervals = grid.map(point => ({ point, hours: (point.end - point.start) / HOUR,
        solar: windows.map(w => point.gti[orientationKey(w.config.azimuthDeg)] * w.config.glassAreaM2 * w.config.gValue),
        direct: windows.map(w => hasDirectSun(point, w.config.azimuthDeg, c)),
    }));
    const potentialWh = intervals.reduce((sum, p) => sum + p.solar.reduce((a, b) => a + b, 0) * p.hours, 0);
    const internalWh = intervals.reduce((sum, p) => sum + room.internalGainsW * p.hours, 0);
    // Storage headroom is measured from the real starting temperature; it is not a fresh daily allowance.
    const sourceBudget = budget + C * (limit - temperature) - internalWh;
    const rollout = (powerTarget: number, allOpen = false): Trajectory => {
        let current = temperature, slab = runtime.residualPowerW;
        let positions = windows.map(w => w.position), lastMoves = windows.map(w => w.lastMoveAt);
        const result: Trajectory = { plan: [], solarWh: 0, heatWh: 0, maxTemp: temperature, comfortFeasible: true };
        for (let index = 0; index < intervals.length; index++) {
            const { point, hours, solar, direct } = intervals[index];
            const heat = heatStep(room, heating, current, slab, hours);
            const maximumPositions = windows.map(w => automaticPosition(100, c.allowedPositions,
                !allOpen && point.start < (w.maximumPositionUntil ?? Infinity) ? w.maximumPosition ?? 100 : 100));
            const eligible = windows.map((w, i) => point.start >= w.movableAfter && (!lastMoves[i] || point.start - lastMoves[i] >= c.minMovementIntervalMinutes * MINUTE));
            const nextPositions = positions.map((p, i) => allOpen ? 100 : eligible[i] && !direct[i] ? maximumPositions[i] : p);
            const controllable = windows.map((_, i) => eligible[i] && direct[i]);
            const horizonEnd = point.start + c.minMovementIntervalMinutes * MINUTE;
            const upcoming = intervals.slice(index).filter(p => p.point.start < horizonEnd);
            // A move commits this position for the whole cooldown. Preserve daylight throughout that period.
            const minimumPositions = solar.map((power, i) => Math.min(maximumPositions[i], Math.max(minimumThermalPosition(power, c.minimumSolarPowerPerWindowW),
                ...upcoming.filter(p => p.solar[i] > 0).map(p => minimumThermalPosition(p.solar[i], c.minimumSolarPowerPerWindowW)))));
            const fixedPower = solar.reduce((sum, p, i) => sum + (controllable[i] ? 0 : p * transmission(windows[i].config, nextPositions[i])), 0);
            const openPower = fixedPower + solar.reduce((sum, p, i) => sum + (controllable[i] ? p * transmission(windows[i].config, maximumPositions[i]) : 0), 0);
            const removablePower = solar.reduce((sum, p, i) => sum + (controllable[i] ? p * (1 - windows[i].config.closedTransmission) * (maximumPositions[i] - minimumPositions[i]) / 100 : 0), 0);
            const minimumPower = openPower - removablePower;
            let target = powerTarget;
            if (!allOpen && current > limit + 0.01) {
                // An already overheated room first sheds its stored heat. This does not starve later, cooler hours.
                const decay = Math.exp(-room.heatLossWK / C * hours);
                const withoutSolar = rcStep(current, point.outsideC, heat.power + room.internalGainsW, room.heatLossWK, C, hours);
                target = Math.min(target, Math.max(0, (limit - withoutSolar) * room.heatLossWK / (1 - decay)));
            }
            let closureFraction = removablePower > 0 ? clamp((openPower - target) / removablePower) : 0;
            // Choose the held position for the strongest upcoming exposure, rather than reacting only to this interval.
            // Other windows are conservatively held at their current position until their own eligible move is evaluated.
            for (const future of upcoming) {
                const futureOpen = future.solar.reduce((sum, p, i) => sum + p * transmission(windows[i].config, controllable[i] ? maximumPositions[i] : nextPositions[i]), 0);
                const futureRemovable = future.solar.reduce((sum, p, i) => sum + (controllable[i] ? p * (1 - windows[i].config.closedTransmission) * (maximumPositions[i] - minimumPositions[i]) / 100 : 0), 0);
                if (futureRemovable > 0) closureFraction = Math.max(closureFraction, clamp((futureOpen - target) / futureRemovable));
            }
            for (let i = 0; i < windows.length; i++) if (!allOpen && controllable[i]) {
                const planned = clamp(maximumPositions[i] - closureFraction * (maximumPositions[i] - minimumPositions[i]), minimumPositions[i], maximumPositions[i]);
                nextPositions[i] = automaticPosition(planned, c.allowedPositions, maximumPositions[i]);
            }
            const solarW = solar.reduce((sum, p, i) => sum + p * transmission(windows[i].config, nextPositions[i]), 0);
            const next = rcStep(current, point.outsideC, solarW + heat.power + room.internalGainsW, room.heatLossWK, C, hours);
            const minimumNext = rcStep(current, point.outsideC, minimumPower + heat.power + room.internalGainsW, room.heatLossWK, C, hours);
            if (!allOpen && current <= limit + 0.01 && next > Math.max(limit, minimumNext) + 0.01) result.comfortFeasible = false;
            lastMoves = nextPositions.map((p, i) => p !== positions[i] ? point.start : lastMoves[i]);
            positions = nextPositions; current = next; slab = heat.slab;
            result.solarWh += solarW * hours; result.heatWh += heat.power * hours; result.maxTemp = Math.max(result.maxTemp, next);
            result.plan.push({ time: point.end, temperature: next, outsideC: point.outsideC, solarW, heatingW: heat.power,
                solarPotentialW: solar.reduce((a, b) => a + b, 0), solarTargetW: allOpen ? solar.reduce((a, b) => a + b, 0) : Math.max(minimumPower, Math.min(openPower, target)),
                directSun: Object.fromEntries(windows.map((w, i) => [w.config.id, direct[i]])), positions: Object.fromEntries(windows.map((w, i) => [w.config.id, positions[i]])) });
        }
        return result;
    };
    const open = rollout(Infinity, true), minimum = rollout(0);
    const feasible = (p: Trajectory): boolean => p.comfortFeasible && p.solarWh <= Math.max(0, sourceBudget - p.heatWh) + 0.01;
    let target = 0, best = minimum;
    let low = 0, high = Math.max(0, ...intervals.map(p => p.solar.reduce((a, b) => a + b, 0)));
    const maximum = rollout(high);
    if (feasible(maximum)) { target = high; best = maximum; }
    else if (feasible(minimum)) {
        // Water filling: find a common admitted-power ceiling for the entire forecast, before spending any budget.
        // Weak-sun hours stay open; intense hours receive more shading. The RC trajectory and heating are checked at every trial.
        for (let iteration = 0; iteration < 32; iteration++) {
            const middle = (low + high) / 2, candidate = rollout(middle);
            if (feasible(candidate)) { low = middle; target = middle; best = candidate; } else high = middle;
        }
    }
    const plan = best.plan, solarBudget = Math.max(0, sourceBudget - best.heatWh);
    return { climateBudget24h: budget, climateIndex: K, capacityWhK: C, timeConstantHours: C / room.heatLossWK,
        solarPotential24h: potentialWh, solarAllowed24h: best.solarWh, heatingEnergyPredicted24h: best.heatWh,
        solarBudget24h: solarBudget, solarPowerTargetW: target, solarBudgetExceeded: best.solarWh > solarBudget + 0.01,
        adaptiveTempLimit: limit, predictedMaxTemp: best.maxTemp, openMaxTemp: open.maxTemp, unavoidableOverheating: minimum.maxTemp > limit + 0.1,
        modelQuality: room.heating.type === 'none' ? 'UNCALIBRATED_RC_LINEAR_SHADING' : `HEURISTIC_${room.heating.type.toUpperCase()}_UNCERTAIN_POWER`,
        targets: plan[0]?.positions ?? {}, plan, openPlan: open.plan };
}
