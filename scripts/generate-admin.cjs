'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { defaults, roomDefaults, windowDefaults, heatingDefaults, normalizeDottedFields } = require('../build/lib/config');
const root = path.join(__dirname, '..');
const labels = {
  enabled: 'Initially enabled', dryRun: 'Dry run: never send motor commands', disabledToday: 'Initially disabled today', vacationMode: 'Initially in vacation mode',
  thermalMode: 'Thermal control mode', latitude: 'Latitude', longitude: 'Longitude', timezone: 'Building timezone (IANA)',
  temperatureSensorId: 'Measured room temperature state (°C)', targetTemperatureC: 'Target temperature (°C)', heatLossWK: 'Heat loss coefficient (W/K)',
  floorAreaM2: 'Floor area (m²)', construction: 'Effective construction mass', internalGainsW: 'Constant internal gains (W)',
  positionStateId: 'Actual motor position state', positionCommandId: 'Motor target state', movementStateId: 'Optional moving indicator state (boolean / 0–1)',
  deviceOpenValue: 'Device value when fully OPEN', deviceClosedValue: 'Device value when fully CLOSED', travelSeconds: 'Motor feedback recognition timeout (seconds)',
  azimuthDeg: 'Compass azimuth (north 0°, east 90°)', tiltDeg: 'Window tilt (vertical = 90°)', glassAreaM2: 'Glazing area (m²)', gValue: 'Glazing g-value (0–1)',
  closedTransmission: 'Residual heat transmission when closed (0–1)', autoMorningOpen: 'Initially allow morning opening', roomId: 'Room ID',
  id: 'Stable ID (letters, numbers, _ or -)', name: 'Display name', nominalPowerW: 'Heuristic nominal heating power (W)', residualTimeHours: 'Underfloor residual time constant (hours)',
  setpointId: 'Read-only heating setpoint state', demandId: 'Read-only heating demand state', valvePositionId: 'Read-only valve position state (%)', type: 'Heating system',
  flowTemperatureId: 'Read-only central supply temperature (°C)', returnTemperatureId: 'Read-only central return temperature (°C)',
  minimumSolarPowerPerWindowW: 'Minimum daylight per window (W)', minMovementIntervalMinutes: 'Minimum time between automatic moves per blind (minutes)',
  allowedPositions: 'Allowed automatic positions (% open)',
  respectManualPositionUntilEndOfDay: 'Keep manual closing as the maximum opening until midnight',
};
const enums = { thermalMode: ['off', 'shadow', 'active'], construction: ['veryLight', 'light', 'medium', 'heavy', 'veryHeavy'], type: ['none', 'radiator', 'underfloor'] };
function field(key, value, attr = key) {
  const result = { type: typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : key.endsWith('Id') && key !== 'roomId' ? 'objectId' : 'text',
    label: labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()), default: value, xs: 12, sm: key.endsWith('Id') ? 12 : 6 };
  if (enums[key]) { result.type = 'select'; result.options = enums[key].map(value => ({ label: value, value })); }
  if (key === 'vacationMode') result.help = 'Open in the morning, keep thermal protection active throughout the control day, and close in the evening. Vacation control ignores per-window enabled and morning-opening flags and does not require daily enrollment. Manual holds, daily manual opening limits, global controls and movement limits still apply. Thermal control requires active mode and valid forecast and room data; schedules remain available without them.';
  if (key === 'autoMorningOpen') result.help = 'Normal mode only. If off, wait for a confirmed external opening before starting thermal control for this blind today. Vacation mode ignores this flag and runs its morning schedule and daytime thermal protection.';
  if (key === 'minimumSolarPowerPerWindowW') Object.assign(result, { min: 0, max: 10000, help: 'Reserve this much estimated unblocked solar power per window, even when the heat budget is exceeded. Limited by available sunlight. Zero disables the daylight minimum.' });
  if (key === 'minMovementIntervalMinutes') Object.assign(result, { min: 15, max: 1440, help: 'Applies to every automatic position change per blind, including morning and vacation schedules. 60 means at most one automatic move per hour. Thermal positions anticipate the full upcoming interval, including changes in solar exposure and daylight. The last-command timestamp survives restarts.' });
  if (key === 'allowedPositions') Object.assign(result, { type: 'chips', sm: 12,
    validator: 'Array.isArray(data.allowedPositions) && data.allowedPositions.length >= 2 && data.allowedPositions.every(p => (typeof p === "number" || typeof p === "string" && p.trim() !== "") && Number.isFinite(Number(p)) && Number(p) >= 0 && Number(p) <= 100) && data.allowedPositions.some(p => Number(p) === 0) && data.allowedPositions.some(p => Number(p) === 100)',
    validatorErrorText: 'Enter percentages from 0 to 100, including 0 and 100.',
    help: 'Automatic targets round toward the next more open allowed position: 17 becomes 20, 20 stays 20, and 1 becomes 10 with the default list. Include 100 and 0; order does not matter. There is no minimum move size. Applies to thermal control, daylight and schedules. A manual opening ceiling uses the highest allowed position at or below that ceiling. Manual controls can use any position.' });
  if (key === 'respectManualPositionUntilEndOfDay') result.help = 'Optional, off by default. If a confirmed manual position is below the plan, remember it as the maximum opening for this blind until local midnight. Fully closing to 0 always establishes the limit. Automatic control can close further and reopen only up to this level. Any later manual move replaces an existing limit, including opening to 90 or 100. This overrides automatic daylight and scheduled opening; the timed manual pause and movement limits still apply. Survives restarts.';
  return { attr, ...result };
}
function fields(keys, source = defaults) { return Object.fromEntries(keys.map(key => { const { attr, ...item } = field(key, source[key]); return [key, item]; })); }
function panel(label, items) { return { type: 'panel', label, items }; }
const config = { type: 'tabs', i18n: false, items: {
  _General: panel('General', { _help: { type: 'staticText', text: 'Runtime switches under global.* and windows.* persist across restarts. Initial switches below are used only when their states are created. Start with dry run and shadow mode; active thermal control additionally requires global.dryRun=false and global.enabled=true. Only blind command IDs are written.', sm: 12 },
    ...fields(['enabled', 'dryRun', 'thermalMode', 'disabledToday', 'vacationMode', 'latitude', 'longitude', 'timezone', 'startupDelaySeconds', 'optimizationIntervalMinutes', 'minimumSolarPowerPerWindowW', 'minMovementIntervalMinutes', 'allowedPositions', 'respectManualPositionUntilEndOfDay']) }),
  _Rooms: panel('Rooms & heating', { rooms: { type: 'accordion', titleAttr: 'name', noDelete: false, sm: 12,
    // Accordion edits use literal keys even though controls read nested paths.
    // Repair its own array in place before Admin renders, exports or saves it.
    onChange: { calculateFunc: `for (const room of data.rooms || []) { (${normalizeDottedFields.toString()})(room, 'heating', ${JSON.stringify(Object.keys(heatingDefaults))}); } return data.rooms;` }, items: [
    ...Object.entries(roomDefaults).filter(([key]) => key !== 'heating').map(([key, value]) => field(key, value)),
    ...Object.entries(heatingDefaults).map(([key, value]) => field(key, value, `heating.${key}`)),
  ] }, ...Object.fromEntries(Object.entries(defaults.centralHeating).map(([key, value]) => { const { attr, ...item } = field(key, value); return [`centralHeating.${key}`, item]; })) }),
  _Windows: panel('Windows', { _help: { type: 'staticText', text: 'All positions and diagnostics: 100 = fully open, 0 = fully closed. Configure raw device endpoints explicitly; the adapter converts them to this convention. Shared actual/target IDs are supported for one window. Use distinct actuator IDs for different windows.', sm: 12 },
    windows: { type: 'accordion', titleAttr: 'name', noDelete: false, sm: 12, items: Object.entries(windowDefaults).map(([key, value]) => field(key, value)) } }),
  _Schedule: panel('Schedules & manual control', fields(['morningEarliest', 'morningLatest', 'morningOffsetMinutes', 'eveningEarliest', 'eveningLatest', 'eveningOffsetMinutes', 'scheduleCatchUpMinutes', 'manualOverrideMinutes', 'firstOpenPercent', 'positionTolerance'])),
  _Model: panel('Forecast & thermal model', { _help: { type: 'staticText', text: 'Open-Meteo GTI is fetched per facade. Forecast / sensor / position ages are minutes. Heating inputs are uncertain indicators, never measured room watts. The initial linear shading curve and thermal parameters need calibration. Check Open-Meteo usage terms for your deployment.', sm: 12 },
    ...fields(['forecastRefreshMinutes', 'forecastMaxAgeMinutes', 'sensorMaxAgeMinutes', 'positionMaxAgeMinutes', 'toleranceMaxC', 'toleranceStartK', 'toleranceFullK', 'limitSmoothingMinutes']) }),
} };
const pkg = { common: { name: 'thermalblindcontrol', version: '0.1.0', titleLang: { en: 'Thermal blind control', de: 'Thermische Rollladensteuerung' },
  desc: { en: 'Forecast-based room thermal modelling and blind control', de: 'Prognosebasierte thermische Raum- und Rollladensteuerung' }, authors: ['Nils'], license: 'MIT',
  platform: 'Javascript/Node.js', mode: 'daemon', main: 'build/main.js', icon: 'thermalblindcontrol.svg', enabled: true, compact: true, connectionType: 'cloud', dataSource: 'poll', type: 'climate-control',
  adminUI: { config: 'json' }, dependencies: [{ 'js-controller': '>=6.0.0' }], globalDependencies: [{ admin: '>=7.0.0' }] }, native: defaults, objects: [], instanceObjects: [] };
fs.writeFileSync(path.join(root, 'admin/jsonConfig.json'), JSON.stringify(config, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'io-package.json'), JSON.stringify(pkg, null, 2) + '\n');
