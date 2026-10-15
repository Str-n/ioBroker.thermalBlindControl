import type { Config } from './config';
import { facadeIncidence, HOUR, MINUTE } from './time';
export interface Sample { val: unknown; ts: number; ack?: boolean; from?: string; q?: number }
export interface ForecastInterval { start: number; end: number; outsideC: number; dni: number; gti: Record<string, number> }
export interface Forecast { fetchedAt: number; source: string; location?: { latitude: number; longitude: number }; intervals: ForecastInterval[] }
export const orientationKey = (azimuth: number): string => String(((azimuth % 360) + 360) % 360);
export const openMeteoAzimuth = (azimuth: number): number => ((azimuth % 360 + 360) % 360) - 180;
export const DIRECT_SUN_MIN_WM2 = 5;
export function directIrradiance(point: ForecastInterval, azimuth: number, c: Config, time = point.start): number {
    return point.dni * facadeIncidence(time, azimuth, c);
}
export function hasDirectSun(point: ForecastInterval, azimuth: number, c: Config, time = point.start): boolean {
    return directIrradiance(point, azimuth, c, time) > DIRECT_SUN_MIN_WM2;
}
export function freshNumber(sample: Sample | undefined, now: number, maxAgeMinutes: number, min: number, max: number): number | null {
    return sample && typeof sample.val === 'number' && Number.isFinite(sample.val) && sample.val >= min && sample.val <= max &&
        Number.isFinite(sample.ts) && sample.ts <= now + MINUTE && now - sample.ts <= maxAgeMinutes * MINUTE && !sample.q ? sample.val : null;
}
export function forecastUrl(c: Config, azimuth: number): string {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    const params = { latitude: c.latitude, longitude: c.longitude, hourly: 'temperature_2m,global_tilted_irradiance,direct_normal_irradiance', tilt: 90,
        azimuth: openMeteoAzimuth(azimuth), timeformat: 'unixtime', timezone: c.timezone, forecast_days: 3, temperature_unit: 'celsius' };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.toString();
}
// GTI at t is the mean over [t-1h,t). Temperatures are instantaneous; use the endpoint mean.
export function parseOpenMeteo(raw: unknown, azimuth: number): ForecastInterval[] {
    const data = raw as { hourly_units?: Record<string, string>; hourly?: Record<string, unknown[]> };
    const hourly = data?.hourly;
    if (data?.hourly_units?.temperature_2m !== '°C' || data?.hourly_units?.global_tilted_irradiance !== 'W/m²' || data?.hourly_units?.direct_normal_irradiance !== 'W/m²') throw new Error('Unexpected forecast units');
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.temperature_2m) || !Array.isArray(hourly.global_tilted_irradiance) || !Array.isArray(hourly.direct_normal_irradiance) ||
        hourly.time.length !== hourly.temperature_2m.length || hourly.time.length !== hourly.global_tilted_irradiance.length || hourly.time.length !== hourly.direct_normal_irradiance.length) throw new Error('Malformed hourly forecast');
    const result: ForecastInterval[] = [];
    const valid = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    for (let i = 1; i < hourly.time.length; i++) {
        const t0 = hourly.time[i - 1], t1 = hourly.time[i];
        const a = hourly.temperature_2m[i - 1], b = hourly.temperature_2m[i], radiation = hourly.global_tilted_irradiance[i], dni = hourly.direct_normal_irradiance[i];
        if (!valid(t0, 1e9, 1e11) || !valid(t1, 1e9, 1e11) || t1 - t0 !== 3600 ||
            !valid(a, -70, 65) || !valid(b, -70, 65) || !valid(radiation, 0, 1800) || !valid(dni, 0, 1800)) continue;
        result.push({ start: t0 * 1000, end: t1 * 1000, outsideC: (a + b) / 2, dni, gti: { [orientationKey(azimuth)]: radiation } });
    }
    return result;
}
export async function fetchForecast(c: Config, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Forecast> {
    const orientations = [...new Set(c.windows.map(w => w.azimuthDeg))];
    if (!orientations.length) throw new Error('No windows configured');
    const series: ForecastInterval[][] = [];
    // Limit concurrent requests to avoid a burst for buildings with many facades.
    for (let i = 0; i < orientations.length; i += 4) {
        const batch = await Promise.all(orientations.slice(i, i + 4).map(async azimuth => {
            const response = await fetcher(forecastUrl(c, azimuth), { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
            return parseOpenMeteo(await response.json(), azimuth);
        }));
        series.push(...batch);
    }
    const maps = series.map(points => new Map(points.map(p => [p.start, p])));
    const intervals = series[0].filter(p => maps.every(m => m.has(p.start))).map(p => ({ ...p, gti: Object.assign({}, ...maps.map(m => m.get(p.start)!.gti)) }));
    const result = { fetchedAt: now, source: 'Open-Meteo GTI', location: { latitude: c.latitude, longitude: c.longitude }, intervals };
    if (!forecastGrid(result, c, now)) throw new Error('Forecast does not cover the next 24 hours for all facades');
    return result;
}
export function forecastGrid(forecast: Forecast | null, c: Config, now: number): ForecastInterval[] | null {
    if (!forecast || !Number.isFinite(forecast.fetchedAt) || forecast.fetchedAt > now + MINUTE || now - forecast.fetchedAt > c.forecastMaxAgeMinutes * MINUTE || !Array.isArray(forecast.intervals)) return null;
    if (forecast.location && (forecast.location.latitude !== c.latitude || forecast.location.longitude !== c.longitude)) return null;
    const orientations = [...new Set(c.windows.map(w => orientationKey(w.azimuthDeg)))];
    const points = forecast.intervals;
    if (points.length > 500) return null;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p || !Number.isFinite(p.start) || p.end <= p.start || !Number.isFinite(p.end) || (i && p.start < points[i - 1].end)) return null;
    }
    const result: ForecastInterval[] = [];
    let cursor = now;
    const end = now + 24 * HOUR;
    for (const p of points) {
        if (p.end <= cursor) continue;
        if (p.start > cursor) return null;
        if (typeof p.outsideC !== 'number' || !Number.isFinite(p.outsideC) || p.outsideC < -70 || p.outsideC > 65 ||
            typeof p.dni !== 'number' || !Number.isFinite(p.dni) || p.dni < 0 || p.dni > 1800 ||
            orientations.some(key => typeof p.gti?.[key] !== 'number' || !Number.isFinite(p.gti[key]) || p.gti[key] < 0 || p.gti[key] > 1800)) return null;
        while (cursor < Math.min(p.end, end)) {
            const next = Math.min(cursor + 15 * MINUTE, p.end, end);
            result.push({ start: cursor, end: next, outsideC: p.outsideC, dni: p.dni, gti: p.gti }); cursor = next;
        }
        if (cursor === end) return result;
    }
    return null;
}
