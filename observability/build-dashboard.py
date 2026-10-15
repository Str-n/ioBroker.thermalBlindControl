#!/usr/bin/env python3
"""Build the existing Grafana dashboard from a live, credential-free ioBroker snapshot."""
import argparse
import copy
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--snapshot', required=True)
parser.add_argument('--existing', required=True)
parser.add_argument('--datasource', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
snapshot = json.loads(Path(args.snapshot).read_text())
existing = json.loads(Path(args.existing).read_text())
config = snapshot['instance']['native']
ds = {'type': 'influxdb', 'uid': args.datasource}
prefix = 'thermalblindcontrol.0'
objects = {o['_id']: o for o in snapshot['objects']}
panels = []
next_id = 1
y = 0


def measurement(state_id):
    return objects.get(state_id, {}).get('common', {}).get('custom', {}).get('influxdb.0', {}).get('aliasId') or state_id


def target(query, alias='$m', ref='A', table=False):
    return {'refId': ref, 'datasource': ds, 'rawQuery': True, 'query': query,
            'resultFormat': 'table' if table else 'time_series', 'alias': alias}


def exact(state_id, alias, last=False, table=False):
    name = json.dumps(measurement(state_id))
    query = f'SELECT last("value") FROM {name} WHERE $timeFilter' if last else f'SELECT last("value") FROM {name} WHERE $timeFilter GROUP BY time($__interval) fill(previous)'
    return target(query, alias, table=table)


def metric(group, key, label=None, last=False, all_items=False, table=False):
    variable = 'room' if group == 'rooms' else 'blind'
    ids = '.*' if all_items else '${' + variable + ':regex}'
    pattern = rf'/^thermalblindcontrol\.0\.{group}\.{ids}\.{key}$/'
    query = f'SELECT last("value") FROM {pattern} WHERE $timeFilter'
    if not last:
        query += ' GROUP BY time($__interval) fill(previous)'
    return target(query, '$3' + (f' · {label}' if label else ''), table=table)


def panel(title, kind, x, width, height, targets=None, unit='none', description='', **options):
    global next_id
    p = {'id': next_id, 'title': title, 'type': kind, 'gridPos': {'x': x, 'y': y, 'w': width, 'h': height},
         'description': description, 'datasource': ds, 'pluginVersion': '13.2.0', 'transparent': False,
         'fieldConfig': {'defaults': {'unit': unit, 'noValue': 'No data', 'color': {'mode': 'palette-classic'},
                                     'mappings': [], 'thresholds': {'mode': 'absolute', 'steps': [{'color': 'green', 'value': None}]}}, 'overrides': []},
         'options': options, 'targets': targets or [], 'interval': '1m', 'maxDataPoints': 1200}
    for i, t in enumerate(p['targets']):
        t['refId'] = chr(65 + i)
    panels.append(p)
    next_id += 1
    return p


def row(title, collapsed=False):
    global y, next_id
    p = {'id': next_id, 'title': title, 'type': 'row', 'collapsed': collapsed,
         'gridPos': {'x': 0, 'y': y, 'w': 24, 'h': 1}, 'panels': []}
    panels.append(p)
    next_id += 1
    y += 1
    return p


def stat(title, x, width, targets, unit='none', height=4):
    return panel(title, 'stat', x, width, height, targets, unit=unit,
                 reduceOptions={'calcs': ['lastNotNull'], 'fields': '/^(?!Time$).*/', 'values': False},
                 orientation='auto', textMode='auto', colorMode='value', graphMode='none', justifyMode='auto')


def graph(title, x, width, height, targets, unit, description=''):
    p = panel(title, 'timeseries', x, width, height, targets, unit, description,
              legend={'displayMode': 'table', 'placement': 'bottom', 'calcs': ['lastNotNull', 'min', 'max']},
              tooltip={'mode': 'multi', 'sort': 'desc'})
    p['fieldConfig']['defaults']['custom'] = {'drawStyle': 'line', 'lineInterpolation': 'stepAfter', 'lineWidth': 2,
        'fillOpacity': 5, 'showPoints': 'auto', 'pointSize': 4, 'spanNulls': False, 'axisCenteredZero': False,
        'axisBorderShow': False, 'scaleDistribution': {'type': 'linear'}, 'stacking': {'mode': 'none', 'group': 'A'}}
    return p


def timeline(title, x, width, height, targets, description=''):
    p = panel(title, 'state-timeline', x, width, height, targets, description=description,
              mergeValues=True, showValue='auto', alignValue='left', rowHeight=0.8,
              legend={'displayMode': 'list', 'placement': 'bottom', 'showLegend': True},
              tooltip={'mode': 'single', 'sort': 'none'})
    p['fieldConfig']['defaults']['custom'] = {'lineWidth': 0, 'fillOpacity': 85, 'spanNulls': False}
    p['fieldConfig']['defaults']['noValue'] = 'Not recorded'
    return p


def binary(p, zero='No', one='Yes', zero_color='dark-green', one_color='orange'):
    p['fieldConfig']['defaults']['mappings'] = [{'type': 'value', 'options': {
        '0': {'text': zero, 'color': zero_color}, '1': {'text': one, 'color': one_color}}}]


def values(p, mappings):
    p['fieldConfig']['defaults']['mappings'] = [{'type': 'value', 'options': {
        key: {'text': text, 'color': color} for key, (text, color) in mappings.items()}}]


def table(title, targets, height=8, description=''):
    p = panel(title, 'table', 0, 24, height, targets, description=description,
              showHeader=True, cellHeight='sm', footer={'show': False})
    p['transformations'] = [{'id': 'reduce', 'options': {'mode': 'seriesToRows', 'reducers': ['lastNotNull'], 'includeTimeField': False}}]
    return p


intro = panel('Thermal blind control · operating context', 'text', 0, 24, 4,
    mode='markdown', content=(
        '**100% = fully open · 0% = fully closed** &nbsp; | &nbsp; '
        '[ioBroker objects](https://192.168.178.40:8081/#tab-objects/select/thermalblindcontrol.0)\n\n'
        'Overview gauges show all blinds. **Room** filters room models; **Blind** filters detailed blind charts. '
        'In **SHADOW / DRY_RUN**, planned positions can differ from actual positions. '
        'Energy and predicted peaks are **rolling 24-hour forecasts recorded at each evaluation**, not measured energy totals. '
        'New diagnostic history starts on 15 October 2026; existing sensor history remains available.'))
y += 4
p = stat('Operating mode', 0, 4, [exact(f'{prefix}.global.operatingMode', 'Mode', last=True)])
values(p, {'SHADOW': ('SHADOW', 'blue'), 'ACTIVE': ('ACTIVE', 'green'), 'DRY_RUN': ('DRY RUN', 'purple')})
p = stat('Forecast valid', 4, 4, [exact(f'{prefix}.global.forecastValid', 'Forecast', last=True)])
binary(p, 'Invalid', 'Valid', 'red', 'green')
p = stat('Adapter alive', 8, 4, [exact(f'system.adapter.{prefix}.alive', 'Adapter', last=True)])
binary(p, 'Stopped', 'Running', 'red', 'green')
stat('Last evaluation', 12, 4, [exact(f'{prefix}.global.lastEvaluation', 'Evaluation', last=True)], 'dateTimeFromNow')
stat('Last forecast refresh', 16, 4, [exact(f'{prefix}.global.lastForecastUpdate', 'Forecast refresh', last=True)], 'dateTimeFromNow')
p = stat('Forecast connection', 20, 4, [exact(f'{prefix}.info.connection', 'Connection', last=True)])
binary(p, 'Unavailable', 'Connected', 'red', 'green')
y += 4
p = timeline('Operating mode history', 0, 12, 5, [exact(f'{prefix}.global.operatingMode', 'Operating mode')])
values(p, {'ACTIVE': ('Active', 'green'), 'SHADOW': ('Shadow', 'blue'), 'DRY_RUN': ('Dry run', 'purple'),
           'DISABLED': ('Disabled', 'gray'), 'DISABLED_TODAY': ('Disabled today', 'gray'), 'VACATION': ('Vacation', 'orange')})
p = timeline('Global operating controls', 12, 12, 5, [exact(f'{prefix}.global.{key}', label) for key, label in [
    ('enabled', 'Automation enabled'), ('dryRun', 'Dry run'), ('disabledToday', 'Disabled today'), ('vacationMode', 'Vacation mode')]])
binary(p, 'Off', 'On', 'gray', 'blue')
y += 5

row('Blind status · 100% open / 0% closed')
for x, key, title in [(0, 'actualPosition', 'All blinds · actual openness'), (12, 'calculatedPosition', 'All blinds · planned openness')]:
    p = panel(title, 'bargauge', x, 12, 12, [metric('windows', key, last=True, all_items=True)], unit='percent',
              displayMode='gradient', orientation='horizontal', showUnfilled=True, namePlacement='left',
              reduceOptions={'calcs': ['lastNotNull'], 'fields': '', 'values': False}, sizing='auto', minVizHeight=12,
              description='All 15 configured blinds. Plans are diagnostic targets, not proof that a motor command was sent.')
    p['fieldConfig']['defaults'].update({'min': 0, 'max': 100, 'decimals': 0,
        'color': {'mode': 'continuous-RdYlGr', 'seriesBy': 'last'}})
y += 12
latest_reason_stat = table('Current control decisions · all blinds', [metric('windows', 'controlReason', last=True, all_items=True)], height=12)
latest_reason_stat['transformations'].append({'id': 'organize', 'options': {'renameByName': {'Field': 'Blind', 'Last *': 'Current decision'}}})
y += 12
p = graph('Actual versus planned openness · ${blind:text}', 0, 24, 9,
          [metric('windows', 'actualPosition', 'Actual'), metric('windows', 'calculatedPosition', 'Plan')], 'percent',
          'Compare acknowledged position feedback with the controller plan. A difference can be expected during manual holds, cooldown, shadow mode, or disabled operation.')
p['fieldConfig']['defaults'].update({'min': 0, 'max': 100, 'decimals': 0})
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byRegexp', 'options': '.*Plan$'}, 'properties': [
    {'id': 'custom.lineStyle', 'value': {'fill': 'dash', 'dash': [6, 4]}}, {'id': 'custom.fillOpacity', 'value': 0}]}]
y += 9
p = timeline('Why the controller moved or waited · ${blind:text}', 0, 24, 8, [metric('windows', 'controlReason')],
             'Exact recorded control reason. Repeated unchanged reasons are periodically recorded to preserve continuity.')
values(p, {key: (label, color) for key, label, color in [
    ('THERMAL_PROTECTION', 'Thermal shading', 'orange'), ('SOLAR_GAIN', 'Open for solar gain', 'green'),
    ('DAYLIGHT_MINIMUM', 'Daylight allowance', 'yellow'), ('NO_DIRECT_SUN', 'No direct sun', 'green'),
    ('MANUAL_LOCK', 'Manual hold', 'purple'), ('MOVEMENT_COOLDOWN', 'Movement interval', 'blue'),
    ('MOVING', 'Motor moving', 'blue'), ('NO_CHANGE', 'Below threshold / no change', 'gray'),
    ('SHADOW_MODE', 'Shadow mode', 'blue'), ('DRY_RUN', 'Dry run', 'purple'),
    ('WINDOW_DISABLED', 'Blind disabled', 'gray'), ('SYSTEM_DISABLED', 'System disabled', 'gray'),
    ('DISABLED_TODAY', 'Disabled today', 'gray'), ('WAIT_FIRST_OPEN', 'Waiting for external opening', 'gray'),
    ('WAIT_MORNING', 'Waiting for morning', 'gray'), ('OUTSIDE_CONTROL_HOURS', 'Outside control hours', 'gray'),
    ('FORECAST_INVALID', 'Invalid forecast', 'red'), ('ROOM_INVALID', 'Invalid room data', 'red'),
    ('POSITION_INVALID', 'Invalid position', 'red'), ('COMMAND_FAILED', 'Command failed', 'red'),
    ('MORNING_OPEN', 'Morning opening', 'green'), ('VACATION_OPEN', 'Vacation opening', 'green'),
    ('VACATION_CLOSE', 'Vacation closing', 'orange'), ('VACATION_WAIT', 'Vacation schedule waiting', 'gray')]})
latest_reason_stat['fieldConfig']['defaults']['mappings'] = copy.deepcopy(p['fieldConfig']['defaults']['mappings'])
latest_reason_stat['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Current decision'}, 'properties': [{'id': 'custom.cellOptions', 'value': {'type': 'color-text'}}]}]
y += 8
p = graph('Direct sunlight on the facade · ${blind:text}', 0, 12, 7, [metric('windows', 'directIrradiance')], 'suffix: W/m²')
p = timeline('Manual holds and direct-sun eligibility · ${blind:text}', 12, 12, 7,
    [metric('windows', 'manualOverrideActive', 'Manual hold'), metric('windows', 'directSun', 'Direct sun')])
binary(p, 'No', 'Yes')
y += 7
p = timeline('Automatic permissions · ${blind:text}', 0, 24, 6,
    [metric('windows', 'enabled', 'Enabled'), metric('windows', 'participatingToday', 'Participating today'), metric('windows', 'autoMorningOpen', 'Morning opening')])
binary(p, 'No', 'Yes', 'gray', 'green')
y += 6

row('Room model · temperatures and the next 24 hours')
p = graph('Measured temperature and forecast peaks · ${room:text}', 0, 16, 9, [
    metric('rooms', 'currentTemperature', 'Measured'), metric('rooms', 'adaptiveTempLimit', 'Comfort limit'),
    metric('rooms', 'predictedMaxTemp', 'Planned 24h peak'), metric('rooms', 'openMaxTemp', '24h peak with all blinds open')], 'celsius',
    'The measured curve is real room temperature. Peak curves summarize the following 24 hours at each timestamp; they are not future observations.')
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byRegexp', 'options': '.*Comfort limit$'}, 'properties': [
    {'id': 'color', 'value': {'mode': 'fixed', 'fixedColor': 'red'}}, {'id': 'custom.lineStyle', 'value': {'fill': 'dash', 'dash': [6, 4]}}]}]
p = stat('Budget / comfort diagnostics · ${room:text}', 16, 8, [
    metric('rooms', 'solarBudgetExceeded', 'Budget exceeded', last=True),
    metric('rooms', 'unavoidableOverheating', 'Unavoidable overheating', last=True)], height=9)
binary(p, 'Within limits', 'Limit exceeded', 'green', 'red')
y += 9
graph('Solar energy allowance and forecast · ${room:text}', 0, 12, 8, [
    metric('rooms', 'solarBudget24h', 'Available solar budget'), metric('rooms', 'solarAllowed24h', 'Admitted solar forecast'),
    metric('rooms', 'solarPotential24h', 'Potential with open blinds'), metric('rooms', 'heatingEnergyPredicted24h', 'Heating forecast')], 'watth',
    'Rolling 24-hour model estimates, in Wh/kWh. Do not sum these values over time as measured consumption.')
graph('Climate cooling budget · ${room:text}', 12, 12, 8, [metric('rooms', 'climateBudget24h', 'Climate budget')], 'watth',
    'Positive: forecast heat loss can absorb solar gain. Negative: outside conditions add heat before solar gain.')
y += 8
graph('Room solar power target and residual heating · ${room:text}', 0, 12, 7,
      [metric('rooms', 'solarPowerTargetW', 'Solar power target'), metric('rooms', 'residualHeatingPower', 'Residual heating estimate')], 'watt')
graph('Climate index · ${room:text}', 12, 12, 7, [metric('rooms', 'climateIndex')], 'celsius',
      'Equivalent target-minus-outdoor temperature difference for the 24-hour climate budget; a temperature difference, not an absolute outdoor temperature.')['fieldConfig']['defaults']['unit'] = 'suffix: K'
y += 7
stat('Effective heat capacity · ${room:text}', 0, 8, [metric('rooms', 'capacityWhK', last=True)], 'suffix: Wh/K')
stat('Room thermal time constant · ${room:text}', 8, 8, [metric('rooms', 'timeConstantHours', last=True)], 'suffix: h')
stat('Model quality · ${room:text}', 16, 8, [metric('rooms', 'modelQuality', last=True)])
y += 4

row('Physical inputs · existing sensor history and heating setpoints')
graph('Measured room sensors · all rooms', 0, 12, 8,
      [exact(room['temperatureSensorId'], room['name']) for room in config['rooms']], 'celsius',
      'Original configured sensors, including their existing InfluxDB aliases. Independent of the Room selector.')
graph('Observed heating setpoints · all rooms', 12, 12, 8,
      [exact(room['heating']['setpointId'], room['name']) for room in config['rooms'] if room['heating'].get('setpointId')], 'celsius',
      'Observed thermostat inputs. The thermal blind adapter does not command heating.')
y += 8

row('Adapter health and diagnostics')
p = graph('Adapter CPU and event loop', 0, 12, 7,
          [exact(f'system.adapter.{prefix}.cpu', 'CPU'), exact(f'system.adapter.{prefix}.eventLoopLag', 'Event loop lag')], 'percent')
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Event loop lag'}, 'properties': [
    {'id': 'unit', 'value': 'ms'}, {'id': 'custom.axisPlacement', 'value': 'right'}]}]
graph('Adapter memory', 12, 12, 7,
      [exact(f'system.adapter.{prefix}.memRss', 'Resident memory'), exact(f'system.adapter.{prefix}.memHeapUsed', 'JavaScript heap')], 'decmbytes')
y += 7
stat('Adapter uptime', 0, 6, [exact(f'system.adapter.{prefix}.uptime', 'Uptime', last=True)], 's')
p = stat('Latest forecast error', 6, 18, [exact(f'{prefix}.global.forecastError', 'Forecast error', last=True)])
values(p, {'': ('No forecast error', 'green')})
p['fieldConfig']['defaults']['noValue'] = 'No forecast error recorded'
y += 4

row('Detailed debug records · command identity, holds, forecasts and model state')
p = table('Manual hold deadlines · ${blind:text}', [metric('windows', 'manualHoldUntil', last=True)], 6,
          'Deadline stored by the controller. Zero means no recorded hold; an expired deadline is not an active hold.')
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Last *'}, 'properties': [{'id': 'unit', 'value': 'dateTimeAsLocal'}]}]
p['fieldConfig']['defaults']['mappings'] = [{'type': 'value', 'options': {'0': {'text': 'No hold'}}}]
y += 6
p = table('Last automatic command · ${blind:text}', [metric('windows', 'lastOwnCommand', last=True)], 8,
          'Persisted command identity, target openness, reason, issue/expiry timestamps and feedback progress. Empty means no recorded automatic command.')
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Last *'}, 'properties': [{'id': 'custom.cellOptions', 'value': {'type': 'json-view'}}]}]
values(p, {'': ('No automatic command recorded', 'gray')})
p['fieldConfig']['defaults']['noValue'] = 'No automatic command recorded'
y += 8
p = table('Latest actuator errors · ${blind:text}', [metric('windows', 'commandError', last=True)], 6)
values(p, {'': ('No command error', 'green')})
p['fieldConfig']['defaults']['noValue'] = 'No command error recorded'
y += 6
for title, group, key in [('Latest temperature plans · ${room:text}', 'rooms', 'temperaturePlan'),
                          ('Room model runtime · ${room:text}', 'rooms', 'runtime'),
                          ('Blind runtime and command tracking · ${blind:text}', 'windows', 'runtime')]:
    p = table(title, [metric(group, key, last=True)], 7,
              'Full JSON retained in InfluxDB for model analysis. Expand the JSON cell; select an earlier dashboard end time to inspect an earlier snapshot.')
    p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Last *'}, 'properties': [{'id': 'custom.cellOptions', 'value': {'type': 'json-view'}}]}]
    y += 7
p = table('Weather forecast snapshot', [exact(f'{prefix}.info.forecastCache', 'Forecast cache', last=True)], 7,
          'Raw fetched forecast, including location, outdoor temperatures, DNI and facade GTI. Expand the JSON cell for full detail.')
p['fieldConfig']['overrides'] = [{'matcher': {'id': 'byName', 'options': 'Last *'}, 'properties': [{'id': 'custom.cellOptions', 'value': {'type': 'json-view'}}]}]
y += 7

room_options = [{'text': r['name'], 'value': r['id'], 'selected': i == 0} for i, r in enumerate(config['rooms'])]
blind_options = [{'text': w['name'], 'value': w['id'], 'selected': False} for w in config['windows']]


def variable(name, label, options, all_selected=False):
    return {'name': name, 'label': label, 'type': 'custom', 'hide': 0, 'multi': True, 'includeAll': True, 'allValue': '.*',
            'query': ','.join(f'{o["text"]} : {o["value"]}' for o in options),
            'current': {'text': ['All'], 'value': ['$__all']} if all_selected else {'text': [options[0]['text']], 'value': [options[0]['value']]},
            'options': [{'text': 'All', 'value': '$__all', 'selected': all_selected}] + options, 'skipUrlSync': False}


dashboard = copy.deepcopy(existing['dashboard'])
debug_index = next(i for i, p in enumerate(panels) if p['type'] == 'row' and p['title'].startswith('Detailed debug records'))
panels[debug_index]['collapsed'] = True
panels[debug_index]['panels'] = panels[debug_index + 1:]
panels = panels[:debug_index + 1]
dashboard.update({'title': 'Thermal Blindcontrol', 'description': 'Thermal blind controller: operational state, room heat models, solar budgets, blind positions and debugging. 100=open, 0=closed.',
    'tags': ['ioBroker', 'thermalblindcontrol', 'blinds', 'debugging'], 'panels': panels, 'schemaVersion': 42,
    'editable': True, 'graphTooltip': 1, 'refresh': '1m', 'timezone': 'browser',
    'time': {'from': 'now-24h', 'to': 'now'}, 'templating': {'list': [variable('room', 'Room', room_options), variable('blind', 'Blind', blind_options, True)]},
    'links': [{'title': 'ioBroker thermal blind objects', 'url': 'https://192.168.178.40:8081/#tab-objects/select/thermalblindcontrol.0', 'type': 'link', 'targetBlank': True}]})
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(dashboard, indent=2) + '\n')
payload = {'dashboard': dashboard, 'folderUid': existing['meta'].get('folderUid', ''), 'overwrite': False,
           'message': 'Add thermal blind debugging, heat budgets, room forecasts, positions, control reasons and health using influxdb.0 history.'}
output.with_suffix('.request.json').write_text(json.dumps(payload, indent=2) + '\n')
all_panels = [child for p in panels for child in [p] + p.get('panels', [])]
print(json.dumps({'uid': dashboard['uid'], 'version': dashboard['version'], 'panels': len(all_panels),
                  'queries': sum(len(p.get('targets', [])) for p in all_panels), 'output': str(output)}))
