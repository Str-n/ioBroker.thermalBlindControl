import SunCalc from 'suncalc';
import type { Config } from './config';
export const HOUR = 3600000;
export const MINUTE = 60000;
export const clamp = (v: number, min = 0, max = 1): number => Math.min(max, Math.max(min, v));
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(time: number, zone: string): Record<string, string> {
    let formatter = formatters.get(zone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        formatters.set(zone, formatter);
    }
    return Object.fromEntries(formatter.formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function localDate(time: number, zone: string): string {
    const p = localParts(time, zone); return `${p.year}-${p.month}-${p.day}`;
}
// Resolve civil times without relying on the process timezone. Schedules avoid the ambiguous 02:00 hour by default.
export function atLocal(date: string, clock: string, zone: string): number {
    const target = Date.parse(`${date}T${clock}:00Z`);
    let result = target;
    for (let i = 0; i < 5; i++) {
        const p = localParts(result, zone);
        const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
        const delta = target - represented;
        if (!delta) return result;
        result += delta;
    }
    // Spring-gap clock times resolve forward to the first existing local minute.
    for (let t = target - 14 * HOUR; t <= target + 14 * HOUR; t += MINUTE) {
        const p = localParts(t, zone);
        if (`${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` >= clock) return t;
    }
    throw new Error('Cannot resolve local time');
}
export function nextMidnight(now: number, zone: string): number {
    const date = new Date(`${localDate(now, zone)}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
    return atLocal(date.toISOString().slice(0, 10), '00:00', zone);
}
export function schedule(now: number, c: Config): { morning: number; evening: number } {
    const day = localDate(now, c.timezone);
    const times = SunCalc.getTimes(new Date(atLocal(day, '12:00', c.timezone)), c.latitude, c.longitude);
    const bounded = (sun: Date, offset: number, earliest: string, latest: string): number => {
        const lo = atLocal(day, earliest, c.timezone), hi = atLocal(day, latest, c.timezone);
        const value = sun.getTime() + offset * MINUTE;
        return Number.isFinite(value) ? clamp(value, lo, hi) : hi;
    };
    return { morning: bounded(times.sunrise, c.morningOffsetMinutes, c.morningEarliest, c.morningLatest), evening: bounded(times.sunset, c.eveningOffsetMinutes, c.eveningEarliest, c.eveningLatest) };
}
export function solarPosition(time: number, c: Pick<Config, 'latitude' | 'longitude'>): { azimuth: number; elevation: number } {
    const p = SunCalc.getPosition(new Date(time), c.latitude, c.longitude);
    return { azimuth: (p.azimuth * 180 / Math.PI + 180 + 360) % 360, elevation: p.altitude * 180 / Math.PI };
}
export function facadeIncidence(time: number, azimuth: number, c: Pick<Config, 'latitude' | 'longitude'>): number {
    const sun = solarPosition(time, c);
    return sun.elevation <= 0 ? 0 : Math.max(0, Math.cos((sun.azimuth - azimuth) * Math.PI / 180) * Math.cos(sun.elevation * Math.PI / 180));
}
