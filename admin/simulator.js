'use strict';
const $ = id => document.getElementById(id);
const presets = { balanced: [14, 15, 20, '2026-07-15'], winter: [2, 10, 20, '2026-01-15'], summer: [23, 15, 22, '2026-07-15'], heatwave: [31, 5, 26, '2026-07-20'], cloudy: [14, 90, 21, '2026-10-15'] };
let config, baseConfig, custom = false, scenario = 'balanced', runtime = null, result = null, playing = false, busy = false, queued = false;
let pendingTemperature = 20, manual = {}, flags = {}, log = [], playTimer, debounce, generation = 0;
const fmt = (n, places = 1) => Number.isFinite(n) ? n.toFixed(places) : '—';
const time = n => new Intl.DateTimeFormat('en-GB', { timeZone: result?.timezone || config?.timezone || 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(n);
const svgNS = 'http://www.w3.org/2000/svg';
function element(tag, attrs, text) { const node = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text !== undefined) node.textContent = text; return node; }
function labels() {
  for (const [id, unit] of [['outsideMean', '°C'], ['clouds', '%'], ['roomTemperature', '°C']]) $(id + 'Value').textContent = `${$(id).value} ${unit}`;
  $('clock').textContent = `${String(Math.floor(Number($('minutes').value) / 60)).padStart(2, '0')}:${String(Number($('minutes').value) % 60).padStart(2, '0')}`;
}
function reset() { generation++; runtime = null; manual = {}; log = []; pendingTemperature = Number($('roomTemperature').value); }
function requestSoon() { labels(); clearTimeout(debounce); debounce = setTimeout(() => run(), 100); }
function simulationSettings() {
  const preferences = { thermalMode: $('thermalMode').value, minimumSolarPowerPerWindowW: Number($('minimumSolarPowerPerWindowW').value), minMovementIntervalMinutes: Number($('minMovementIntervalMinutes').value), allowedPositions: $('allowedPositions').value.split(',').map(value => value.trim() === '' ? '' : Number(value)), respectManualPositionUntilEndOfDay: $('respectManualPositionUntilEndOfDay').checked };
  const settings = { ...config, ...preferences, ...(config.global ? { global: { ...config.global, ...preferences } } : {}) };
  delete settings.minPositionChange;
  if (settings.global) delete settings.global.minPositionChange;
  return settings;
}
async function run(timestamp) {
  if (!config) return;
  if (busy) { queued = true; return; }
  busy = true; $('runStatus').textContent = 'Calculating…';
  const version = generation, changes = { ...manual }, roomTemperature = pendingTemperature;
  const controls = Object.fromEntries(['enabled', 'disabledToday', 'vacationMode', 'dryRun'].map(key => [key, $(key).checked]));
  const settings = simulationSettings();
  const body = { config: settings, scenario, date: $('date').value, minutes: Number($('minutes').value), timestamp,
    outsideMean: Number($('outsideMean').value), clouds: Number($('clouds').value), roomTemperature,
    ...(!custom ? { heatLossWK: Number($('heatLoss').value), floorAreaM2: Number($('floorArea').value), heatingType: $('heatingType').value } : {}),
    heatingDemand: $('heatingDemand').checked, controls, flags, manualChanges: changes, forecastFailure: $('forecastFailure').checked, sensorFailure: $('sensorFailure').checked, runtime };
  try {
    const response = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (version !== generation) { queued = true; return; }
    result = data; runtime = data.runtime;
    if (pendingTemperature === roomTemperature) pendingTemperature = undefined;
    for (const [key, value] of Object.entries(changes)) if (manual[key] === value) delete manual[key];
    for (const w of data.windows.filter(w => w.moved)) log.unshift(`${time(data.timestamp)} · ${w.name}: ${fmt(w.previousPosition, 0)} → ${fmt(w.position, 0)}% open · ${w.reason}`);
    log = log.slice(0, 100); $('error').hidden = true;
    for (const key of ['enabled', 'disabledToday', 'vacationMode', 'dryRun']) $(key).checked = runtime.global[key];
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(data.timestamp).map(p => [p.type, p.value]));
    $('date').value = `${p.year}-${p.month}-${p.day}`; $('minutes').value = Number(p.hour) * 60 + Number(p.minute); $('dateLabel').textContent = data.timezone;
    const selected = $('roomSelect').value;
    $('roomSelect').replaceChildren(...data.rooms.map(r => { const option = document.createElement('option'); option.value = r.id; option.textContent = r.name; return option; }));
    if (data.rooms.some(r => r.id === selected)) $('roomSelect').value = selected;
    render(); labels(); $('runStatus').textContent = controls.dryRun ? 'Dry run' : !controls.enabled ? 'Disabled' : controls.disabledToday ? 'Disabled today' : controls.vacationMode ? 'Vacation' : !data.forecastValid ? 'Forecast unavailable' : 'Simulation ready';
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; $('runStatus').textContent = 'Simulation error'; stop(); }
  finally { busy = false; if (queued) { queued = false; requestSoon(); } else if (playing) playTimer = setTimeout(() => run((runtime?.timestamp || Date.now()) + 15 * 60000), 750); }
}
function stop() { playing = false; clearTimeout(playTimer); $('play').textContent = '▶ Play'; }
function render() {
  const room = result.rooms.find(r => r.id === $('roomSelect').value) || result.rooms[0]; if (!room) return;
  if (pendingTemperature === undefined && document.activeElement !== $('roomTemperature')) $('roomTemperature').value = room.temperature.toFixed(1);
  const m = room.model; $('roomTitle').textContent = room.name;
  $('budget').textContent = m ? `${fmt(m.climateBudget24h / 1000)} kWh` : '—';
  $('climate').textContent = m ? `Climate index ${fmt(m.climateIndex)} K · ${m.climateBudget24h < 0 ? 'net ambient heat gain' : 'net cooling potential'}` : 'Forecast / room data unavailable';
  $('limit').textContent = m ? `${fmt(m.adaptiveTempLimit)} °C` : '—';
  $('capacity').textContent = m ? `Capacity ${fmt(m.capacityWhK, 0)} Wh/K · time constant ${fmt(m.timeConstantHours)} h` : '—';
  $('peak').textContent = m ? `${fmt(m.predictedMaxTemp)} °C` : '—';
  $('openPeak').textContent = m ? `All open: ${fmt(m.openMaxTemp)} °C` : 'No thermal commands';
  $('solar').textContent = m ? `${fmt(m.solarAllowed24h / 1000)} kWh` : '—';
  $('potential').textContent = m ? `Potential ${fmt(m.solarPotential24h / 1000)} kWh · heating ${fmt(m.heatingEnergyPredicted24h / 1000)} kWh` : '—';
  $('currentTemp').textContent = `Measured room ${fmt(room.temperature)} °C`;
  $('outsideTemp').textContent = `Outside ${fmt(result.outsideTemperature)} °C`;
  $('schedule').textContent = `Morning ${time(result.schedule.morning)} · Evening ${time(result.schedule.evening)}`;
  $('sunPosition').textContent = `Sun ${fmt(result.sun.azimuth, 0)}° azimuth / ${fmt(result.sun.elevation, 0)}° elevation`;
  $('modelNote').textContent = m ? `${m.unavoidableOverheating ? 'Comfort limit cannot be maintained with shading alone. ' : ''}Estimated residual floor heat: ${fmt(room.residualPowerW, 0)} W. ${m.modelQuality.replaceAll('_', ' ').toLowerCase()}. The chart shows the thermal plan; operating controls can block its execution.` : 'Thermal prediction unavailable. Vacation and morning schedules still use their independent operating rules.';
  $('modelNote').classList.toggle('warning', Boolean(m?.unavoidableOverheating));
  renderScene(room); renderChart(room); renderSolarChart(room); renderWindows(room);
  $('log').replaceChildren(...(log.length ? log : ['No automatic movements yet.']).map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
}
function renderScene(room) {
  const scene = $('scene'); scene.replaceChildren();
  scene.append(element('rect', { x: 20, y: 5, width: 680, height: 338, rx: 20, fill: '#f0f4eb' }), element('rect', { x: 180, y: 70, width: 360, height: 220, rx: 9, fill: '#e2ddcd', stroke: '#506557', 'stroke-width': 10 }));
  for (let x = 200; x < 540; x += 35) scene.append(element('line', { x1: x, y1: 76, x2: x, y2: 284, stroke: '#d6d0be', 'stroke-width': 1 }));
  const sunAngle = result.sun.azimuth * Math.PI / 180;
  const sunX = 360 + Math.sin(sunAngle) * 290, sunY = 175 - Math.cos(sunAngle) * 147;
  if (result.sun.elevation > 0) {
    scene.append(element('line', { x1: sunX, y1: sunY, x2: 360, y2: 180, stroke: '#d5a34e', 'stroke-dasharray': '5 7', opacity: 0.5 }));
    scene.append(element('circle', { cx: sunX, cy: sunY, r: 17, fill: '#f5cb76' }), element('text', { x: sunX, y: sunY + 5, 'text-anchor': 'middle', fill: '#9b6824', 'font-size': 18 }, '☀'));
  }
  for (const w of result.windows.filter(w => w.roomId === room.id)) {
    const a = w.azimuth * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a), scale = Math.min(180 / Math.max(.001, Math.abs(dx)), 110 / Math.max(.001, Math.abs(dy)));
    const x = 360 + dx * scale, y = 180 + dy * scale, vertical = Math.abs(dx * scale) > 179;
    if (w.directSun) scene.append(element('polygon', { points: `${x - (vertical ? 0 : 32)},${y - (vertical ? 32 : 0)} ${x + (vertical ? 0 : 32)},${y + (vertical ? 32 : 0)} ${360 + dx * 30},${180 + dy * 30}`, fill: '#ffc75c', opacity: Math.min(.5, w.directIrradiance / 1500) * w.position / 100 }));
    scene.append(element('rect', { x: x - (vertical ? 5 : 34), y: y - (vertical ? 34 : 5), width: vertical ? 10 : 68, height: vertical ? 68 : 10, rx: 2, fill: '#aad2cc' }));
    scene.append(element('rect', { x: x - (vertical ? 5 : 34), y: y - (vertical ? 34 : 5), width: vertical ? 10 : 68 * (1 - w.position / 100), height: vertical ? 68 * (1 - w.position / 100) : 10, fill: '#326f59' }));
    scene.append(element('text', { x: x + dx * 57, y: y + dy * 26 + 4, 'text-anchor': 'middle', fill: '#47634f', 'font-size': 11 }, `${w.name} · ${fmt(w.position, 0)}% open`));
  }
  scene.append(element('rect', { x: 284, y: 144, width: 152, height: 72, rx: 12, fill: '#fffdf6', opacity: .94 }), element('text', { x: 360, y: 174, 'text-anchor': 'middle', fill: '#244c38', 'font-size': 25, 'font-weight': 600 }, `${fmt(room.temperature)} °C`), element('text', { x: 360, y: 196, 'text-anchor': 'middle', fill: '#7b877b', 'font-size': 10 }, room.name), element('text', { x: 675, y: 30, 'text-anchor': 'middle', fill: '#829080', 'font-size': 12 }, 'N ↑'));
}
function renderChart(room) {
  const chart = $('chart'); chart.replaceChildren(); const m = room.model;
  if (!m) { chart.append(element('text', { x: 450, y: 125, 'text-anchor': 'middle', fill: '#718079', 'font-size': 15 }, 'No valid temperature forecast')); return; }
  const values = [room.temperature, m.adaptiveTempLimit, ...m.plan.flatMap(p => [p.temperature, p.outsideC]), ...m.openPlan.map(p => p.temperature)];
  const lo = Math.floor(Math.min(...values) / 5) * 5 - 1, hi = Math.ceil(Math.max(...values) / 5) * 5 + 1;
  const x = t => 55 + (t - result.timestamp) / (24 * 3600000) * 820, y = v => 215 - (v - lo) / (hi - lo) * 190;
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; chart.append(element('line', { x1: 55, x2: 875, y1: y(v), y2: y(v), stroke: '#e8ece5' }), element('text', { x: 45, y: y(v) + 4, 'text-anchor': 'end', fill: '#879486', 'font-size': 11 }, `${fmt(v, 0)}°`)); }
  for (let h = 0; h <= 24; h += 4) chart.append(element('text', { x: x(result.timestamp + h * 3600000), y: 240, 'text-anchor': 'middle', fill: '#879486', 'font-size': 11 }, `${time(result.timestamp + h * 3600000)}${h === 24 ? ' +1' : ''}`));
  const line = (points, color, dashed = false) => chart.append(element('polyline', { points: points.map(p => `${x(p[0])},${y(p[1])}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, ...(dashed ? { 'stroke-dasharray': '6 5' } : {}) }));
  line([[result.timestamp, m.adaptiveTempLimit], [result.timestamp + 24 * 3600000, m.adaptiveTempLimit]], '#b45140', true);
  line([[result.timestamp, result.outsideTemperature], ...m.plan.map(p => [p.time, p.outsideC])], '#9aacc1');
  line([[result.timestamp, room.temperature], ...m.openPlan.map(p => [p.time, p.temperature])], '#d99a41', true);
  line([[result.timestamp, room.temperature], ...m.plan.map(p => [p.time, p.temperature])], '#26735a');
}
function renderSolarChart(room) {
  const chart = $('solarChart'); chart.replaceChildren(); const m = room.model;
  $('solarTarget').textContent = m ? `Room target ${fmt(m.solarPowerTargetW, 0)} W` : '—';
  $('solarBudgetNote').textContent = m ? `Solar budget ${fmt(m.solarBudget24h / 1000, 2)} kWh · admitted ${fmt(m.solarAllowed24h / 1000, 2)} kWh. ${m.solarBudgetExceeded ? 'The daylight minimum, unshadable heat or movement guards exceed the budget.' : 'Stronger sunlight receives more shading; weaker sunlight is admitted where possible.'}` : 'Solar distribution is unavailable without a valid forecast and room sensor.';
  $('solarBudgetNote').classList.toggle('warning', Boolean(m?.solarBudgetExceeded));
  if (!m) { chart.append(element('text', { x: 450, y: 100, 'text-anchor': 'middle', fill: '#718079', 'font-size': 14 }, 'No valid solar forecast')); return; }
  const maximum = Math.max(100, Math.ceil(Math.max(m.solarPowerTargetW, ...m.plan.map(p => p.solarPotentialW)) / 250) * 250);
  const x = t => 65 + (t - result.timestamp) / (24 * 3600000) * 810, y = v => 180 - v / maximum * 155;
  for (let i = 0; i <= 4; i++) { const value = maximum * i / 4; chart.append(element('line', { x1: 65, x2: 875, y1: y(value), y2: y(value), stroke: '#e8ece5' }), element('text', { x: 55, y: y(value) + 4, 'text-anchor': 'end', fill: '#879486', 'font-size': 10 }, `${fmt(value, 0)} W`)); }
  for (let h = 0; h <= 24; h += 4) chart.append(element('text', { x: x(result.timestamp + h * 3600000), y: 205, 'text-anchor': 'middle', fill: '#879486', 'font-size': 11 }, time(result.timestamp + h * 3600000)));
  const line = (points, color, dashed = false) => chart.append(element('polyline', { points: points.map(p => `${x(p[0])},${y(p[1])}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, ...(dashed ? { 'stroke-dasharray': '6 5' } : {}) }));
  const steps = key => m.plan.flatMap((p, i) => [[i ? m.plan[i - 1].time : result.timestamp, p[key]], [p.time, p[key]]]);
  line(steps('solarPotentialW'), '#d99a41'); line([[result.timestamp, m.solarPowerTargetW], [result.timestamp + 24 * 3600000, m.solarPowerTargetW]], '#b45140', true); line(steps('solarW'), '#26735a');
}
function renderWindows(room) {
  $('windows').replaceChildren(...result.windows.filter(w => w.roomId === room.id).map(w => {
    const card = document.createElement('article'); card.className = 'window';
    const header = document.createElement('header'), name = document.createElement('h3'), reason = document.createElement('span'); name.textContent = w.name; reason.className = 'reason'; reason.textContent = w.reason.replaceAll('_', ' '); header.append(name, reason);
    const positions = document.createElement('div'); positions.className = 'positions';
    const actual = document.createElement('span'); actual.textContent = `Actual ${fmt(w.position, 0)}% open`;
    const target = document.createElement('span'); target.textContent = `Plan ${fmt(w.calculatedPosition, 0)}% · GTI ${fmt(w.gti, 0)} W/m²`; positions.append(actual, target);
    const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 100; range.step = 1; range.value = w.position; range.setAttribute('aria-label', `${w.name} manual openness`);
    range.addEventListener('change', () => { manual[w.id] = Number(range.value); requestSoon(); });
    const checks = document.createElement('div'); checks.className = 'flags';
    for (const [key, text] of [['enabled', 'Enabled'], ['autoMorningOpen', 'Morning opening']]) { const label = document.createElement('label'); label.className = 'toggle'; const box = document.createElement('input'); box.type = 'checkbox'; box.checked = w[key]; box.addEventListener('change', () => { flags[w.id] = { ...flags[w.id], [key]: box.checked }; requestSoon(); }); label.append(box, document.createTextNode(text)); checks.append(label); }
    const hold = document.createElement('div'); hold.className = 'hold'; hold.textContent = w.manualHoldUntil > result.timestamp ? `Manual hold until ${time(w.manualHoldUntil)}` : result.runtime.global.vacationMode ? 'Vacation: daytime thermal control' : w.participatingToday ? 'Participating today' : 'Awaiting morning / external opening';
    const sunlight = document.createElement('div'); sunlight.className = 'muted'; sunlight.textContent = w.directSun ? `Direct sun · ${fmt(w.directIrradiance, 0)} W/m²` : 'No direct sun · no thermal closing';
    const daylight = document.createElement('div'); daylight.className = 'muted'; daylight.textContent = `Daylight ${fmt(w.daylightPowerW)} W · minimum ${fmt(w.minimumSolarW)} W`;
    const manualLimit = document.createElement('div'); manualLimit.className = 'muted'; manualLimit.textContent = w.manualPositionLimitActive ? `Maximum opening today: ${fmt(w.manualPositionLimit, 0)}% · resets at midnight` : '';
    card.append(header, positions, sunlight, daylight, range, checks, hold, manualLimit); return card;
  }));
}
$('play').addEventListener('click', () => { if (playing) stop(); else { playing = true; $('play').textContent = 'Ⅱ Pause'; run((runtime?.timestamp || result.timestamp) + 15 * 60000); } });
$('step').addEventListener('click', () => { stop(); run((runtime?.timestamp || result.timestamp) + 15 * 60000); });
$('reset').addEventListener('click', () => { stop(); reset(); requestSoon(); });
for (const id of ['date', 'minutes']) $(id).addEventListener('input', () => { stop(); generation++; requestSoon(); });
for (const id of ['outsideMean', 'clouds', 'heatLoss', 'floorArea', 'heatingType', 'heatingDemand', 'minimumSolarPowerPerWindowW', 'minMovementIntervalMinutes', 'allowedPositions', 'respectManualPositionUntilEndOfDay', 'enabled', 'disabledToday', 'vacationMode', 'dryRun', 'thermalMode', 'forecastFailure', 'sensorFailure']) $(id).addEventListener('input', requestSoon);
$('roomTemperature').addEventListener('input', () => { pendingTemperature = Number($('roomTemperature').value); requestSoon(); });
$('roomSelect').addEventListener('change', render);
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  stop(); scenario = button.dataset.scenario; const [outside, clouds, room, date] = presets[scenario];
  $('outsideMean').value = outside; $('clouds').value = clouds; $('roomTemperature').value = room; $('date').value = date;
  document.querySelectorAll('[data-scenario]').forEach(b => b.classList.toggle('selected', b === button)); reset(); requestSoon();
}));
function loadShadingPreferences() { $('minimumSolarPowerPerWindowW').value = config.global?.minimumSolarPowerPerWindowW ?? config.minimumSolarPowerPerWindowW ?? 0; $('minMovementIntervalMinutes').value = config.global?.minMovementIntervalMinutes ?? config.minMovementIntervalMinutes ?? 15; $('allowedPositions').value = (config.global?.allowedPositions ?? config.allowedPositions ?? [100, 80, 60, 40, 20, 10, 0]).join(', '); $('respectManualPositionUntilEndOfDay').checked = config.global?.respectManualPositionUntilEndOfDay ?? config.respectManualPositionUntilEndOfDay ?? false; }
$('applyConfig').addEventListener('click', () => { try { config = JSON.parse($('configuration').value); custom = true; $('thermalMode').value = config.thermalMode || 'active'; loadShadingPreferences(); flags = {}; reset(); requestSoon(); } catch (e) { $('error').textContent = e.message; $('error').hidden = false; } });
$('demoConfig').addEventListener('click', () => { config = structuredClone(baseConfig); custom = false; $('configuration').value = JSON.stringify(config, null, 2); loadShadingPreferences(); flags = {}; reset(); requestSoon(); });
$('export').addEventListener('click', () => { if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify({ config: simulationSettings(), result, log }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'thermal-blind-simulation.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
fetch('/api/config').then(r => { if (!r.ok) throw new Error('Unable to load simulator configuration'); return r.json(); }).then(data => { baseConfig = data; config = structuredClone(data); $('configuration').value = JSON.stringify(data, null, 2); loadShadingPreferences(); labels(); run(); }).catch(e => { $('error').textContent = e.message; $('error').hidden = false; });
