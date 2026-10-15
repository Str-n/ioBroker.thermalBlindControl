# InfluxDB history and Grafana debugging

The live installation uses `thermalblindcontrol.0`, `influxdb.0`, and the existing Grafana **InfluxDB** data source (`seII16iRz`, database `home`, InfluxQL).

[Open the dashboard](http://192.168.178.40:3000/d/adrd76w/thermal-blindcontrol?orgId=1&from=now-24h&to=now&timezone=browser).

## History coverage

Configured on 15 October 2026 for 8 rooms and 15 blinds: **399 datapoints**, including 382 newly configured states and 17 existing input history configurations preserved with their aliases and settings.

- All controller states: operating switches, reasons, forecast validity, refresh/evaluation timestamps, room temperatures, heat budgets, predicted peaks, thermal parameters, heating estimates, blind positions, sunlight, permissions, manual holds and command errors.
- Full JSON diagnostics: forecast cache, temperature plans, room/window runtime and last command identity/progress. These support later calibration and investigation without discarding model inputs.
- All configured external position feedback/command states, room temperature sensors and heating inputs.
- Adapter alive/connected state, CPU, event-loop lag, memory and uptime.

New numeric and Boolean histories use numeric storage; text and JSON histories use string storage. Changes are recorded with zero debounce, zero block time and no minimum delta. Zero, negative and false values are retained. Unchanged scalar states are re-recorded every 5 minutes; large JSON records every hour. Command records have no periodic re-recording. Existing enabled input histories retain their original configuration. Retention settings for the InfluxDB instance are unchanged.

History activation records the current snapshot through the InfluxDB adapter. New diagnostic history starts when logging was enabled; it cannot reconstruct earlier controller decisions. Previously recorded room sensor data remains available.

## Dashboard

The dashboard retains UID `adrd76w` and its existing folder. It refreshes every minute and uses browser timezone, with a default 24-hour history.

- Overview: operating mode, forecast health, adapter health, evaluation freshness and global operating controls.
- Blind overview: actual/planned openness for every blind and current control reasons.
- Detailed blind charts: actual versus planned position, reason timeline, direct sunlight, manual holds and automatic permissions.
- Room model: measured temperature, adaptive comfort limit, predicted 24-hour peaks, solar budget/potential/admitted forecasts, climate budget, power target, residual heating and thermal parameters.
- Physical inputs: original temperature sensors and observed heating setpoints, including existing measurement aliases.
- Adapter CPU, memory, event-loop latency, uptime and forecast errors.
- Expand **Detailed debug records** for command JSON, hold deadlines, actuator errors, temperature plans, model runtime and raw weather forecasts. Select an earlier dashboard end time to inspect earlier snapshots.

**All positions are percent open: 100 = fully open, 0 = fully closed.** Planned positions can differ from actual positions in shadow mode, during manual holds or when operating permissions block a move. Solar energy values and predicted peaks are rolling 24-hour model outputs recorded at each evaluation, not measured energy consumption.

The Room selector filters room model panels. The Blind selector filters detailed blind panels independently. The overview gauges always show all blinds; physical sensor charts show all rooms.

## Reconfigure after adding rooms or windows

`configure-history.cjs` discovers the deployed configuration and state objects. Run it inside the ioBroker container. By default it previews changes; `--apply` enables history and verifies every saved object. It changes only `common.custom['influxdb.0']` history metadata.

```sh
# Preview; no objects are changed.
ssh pi@192.168.178.40 'sudo -n docker exec -i smarthome-iobroker-1 node -' \
  < observability/configure-history.cjs

# Apply and verify history settings, backing up the selected objects first.
ssh pi@192.168.178.40 'sudo -n docker exec -i smarthome-iobroker-1 node - --apply' \
  < observability/configure-history.cjs
```

Backups are stored inside ioBroker's persistent data volume under `thermalblindcontrol-observability/<UTC timestamp>/`: `before.json` contains the original objects, native configuration and current state snapshot; `history-plan.json` records the exact history configuration. Restore only the corresponding history metadata when rolling back; do not replay actuator or operating-control state values from the snapshot.

`thermal-blindcontrol-dashboard.json` is the installed dashboard export. `build-dashboard.py` regenerates it from a live snapshot and an existing Grafana dashboard response, preserving the dashboard identity/version and resolving existing InfluxDB aliases. Supply authentication only when calling Grafana; credentials are not embedded in the dashboard or scripts.

```sh
python3 observability/build-dashboard.py \
  --snapshot /path/to/live-iobroker-snapshot.json \
  --existing /path/to/grafana-dashboard-response.json \
  --datasource seII16iRz \
  --output observability/thermal-blindcontrol-dashboard.json
```

Logging settings follow the [ioBroker InfluxDB adapter](https://github.com/ioBroker/ioBroker.influxdb). Dashboard queries use the existing data source's [InfluxQL support](https://grafana.com/docs/grafana/latest/datasources/influxdb/query-editor/).
