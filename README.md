# ioBroker.thermalblindcontrol

Forecast-based thermal blind control, implemented from [the German V1 plan](thermische_rollladensteuerung_iobroker_plan.md). This is a separate alternative to `ioBroker.blindcontrol`, with its own adapter namespace, configuration and decision engine.

It models each room's heat losses, heat storage, solar gain through each facade and approximate heating response over the **next 24 elapsed hours**. It distributes the available solar heat budget over the forecast using partial blind positions, then applies independent operating permissions before sending only the current step. **Heating is observed, never controlled.**

Node.js 20+, ioBroker js-controller 6+, Admin 7+. The npm name and ioBroker namespace are lowercase: `iobroker.thermalblindcontrol` / `thermalblindcontrol.0`. The source directory retains the requested `ioBroker.thermalBlindControl` name.

## Build, test and package

```sh
cd ioBroker.thermalBlindControl
npm ci
npm test
npm pack
```

Install `iobroker.thermalblindcontrol-0.1.0.tgz` through your ioBroker installation's local adapter package workflow, then add an instance. Compiled code, Admin configuration, simulator and documentation are included. No real ioBroker installation is contacted by builds, tests or the simulator.

## Virtual house simulator

```sh
npm run simulator
```

Open **http://127.0.0.1:4174**. The default port differs from blindcontrol's 4173, so both simulators can run together. Override it with `THERMALBLINDCONTROL_SIMULATOR_PORT=4180 npm run simulator`. Stop with Ctrl+C. A source checkout is rebuilt automatically; an installed package uses its included compiled engine.

The simulator includes:

- A room view with facade directions, sun position, light and blind positions.
- Balanced gains, winter sun, summer, heatwave and cloudy autumn presets; adjustable date, time, outdoor temperature and cloud cover. The initial balanced scenario demonstrates partial shading with a positive heat budget.
- A 24-hour chart of the optimized room temperature, all-open baseline, outside temperature and adaptive comfort limit.
- Climate budget, solar potential/admitted energy, heating energy and residual underfloor heat diagnostics.
- A solar-power chart comparing available and admitted power with the room-wide target. Stronger sunlight receives more shading; each window indicates whether it currently receives direct sun.
- **Daylight & movement** controls for a minimum watt allowance per window and the minimum interval between automatic moves. Window cards show the estimated unblocked daylight power and its effective minimum.
- Time scrubbing, playback and 15-minute steps. Small forward steps evolve the virtual room from its prior temperature and actual blind positions; backwards jumps or jumps over two hours begin a fresh run.
- Manual sliders that start the same per-window hold as the adapter, window participation flags, global/daily switches, vacation mode, dry run, shadow mode and forecast/sensor failure switches.
- A JSON configuration editor for testing your own rooms and windows, a room selector, movement log and JSON export.

Weather is **synthetic**, not live Open-Meteo data. The synthetic facade irradiance is a simplified sunlight approximation. Decisions, thermal forecasts, permission checks and motor-feedback recognition use the adapter's modules. Virtual motors complete immediately; the simulation plant is an approximate room model, not independent validation of a building's physics. The demo starts at noon with its morning routine already completed. Start before morning or disable morning participation to test enrollment. Loaded configurations use virtual sensors and never contact their configured ioBroker IDs. Room H/C and heating-type sliders apply to the default demo; a loaded configuration supplies its own room settings. The demand toggle applies to all simulated heating systems.

## Commissioning

1. In **Rooms & heating**, add stable room IDs and measured Celsius temperature state IDs. Enter room area, construction class and heat-loss coefficient H. Set heating type and optional **read-only** heating indicators. Shared supply/return temperatures describe the central system, not a measured room heat flow.
2. In **Windows**, assign each window to a room and configure glass area, g-value, compass azimuth, actual/command state IDs and device endpoints. Optional moving indicators must be boolean or numeric 0/1. See [example configuration](examples/neuwied.json).
3. Check location and IANA timezone. Defaults are Neuwied, 50.47° N / 7.47° E, `Europe/Berlin`. Calendar operations use this configured timezone, independently of the host timezone.
4. The adapter starts **disabled**, in **shadow mode**, with **dry run enabled**. Set `global.enabled=true` and inspect diagnostics. Set `thermalMode=active` in Admin when ready to evaluate active thermal control. Only `global.dryRun=false` allows real commands, including scheduled morning/vacation movements.
5. Use the runtime states below for normal operation. Saving Admin settings or restarting preserves existing runtime switch choices; the Admin switch values are initialization defaults.

Room heating edits are saved inside each room's `heating` object. Older Admin configurations containing literal keys such as `"heating.nominalPowerW"` are repaired on adapter startup: the dotted GUI value takes precedence over the stale nested value, then the duplicate key is removed. Existing JSON imports receive the same normalization. After updating, restart the instance and reopen its settings to load the repaired values.

Do not enable both adapters for the same motor at once. Their commands would be external actions to each other. Real actuator travel limits and obstacle protection remain the device's responsibility.

### Position convention

**Every adapter and simulator position is percent OPEN: 100 = fully open, 0 = fully closed.** This includes actual/target states, temperature plans, manual sliders, command tracking and exported simulation data, matching the sibling blindcontrol adapter.

Raw motor values are converted at the adapter boundary. The default device endpoints already use 100 = open and 0 = closed. For hardware with another native range, configure the raw endpoint values below; normalized positions always retain the convention above.

| Raw motor format | `deviceOpenValue` | `deviceClosedValue` |
| --- | ---: | ---: |
| Standard percentage | 100 | 0 |
| Inverted hardware percentage | 0 | 100 |
| Inverted hardware fraction | 0 | 1 |
| Byte range | 255 | 0 |

Actual and target may share one state ID for a window. An unacknowledged target is not treated as actual position feedback. Different windows must not share actuator IDs. The schematic plan's legacy `openIsPercent` setting is also accepted if explicit endpoints are absent. Only finite numeric actual readings within the configured endpoints are accepted.

Saved runtime positions from the earlier convention are migrated automatically once, including outstanding command targets and progress. Command identities, timestamps, movement cooldowns and manual holds are retained. Updated runtime and simulator output include `positionConvention: percentOpen` to identify the convention explicitly.

### Daylight and automatic movement settings

These settings are in the Admin **General** tab and the simulator's **Daylight & movement** section:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `minimumSolarPowerPerWindowW` | 0 W | Reserve at least this much estimated solar power through each window's uncovered glazing, even when the heat budget or comfort target is exceeded. Range: 0–10,000 W. Zero disables the minimum. |
| `minMovementIntervalMinutes` | 15 min | Minimum time between any two automatic position changes of the same blind. Range: 15–1,440 minutes. Set 60 for at most one automatic move per hour. |
| `minPositionChange` | 10 percentage points | Minimum absolute difference between the actual and requested position for any automatic move, in either direction. Range: 1–100. Targets whose position plus this threshold exceeds 100 snap to fully open first. Smaller moves are ignored; an exact match to the threshold is allowed. |
| `respectManualPositionUntilEndOfDay` | `false` | Remember a manual position below the plan as that blind's maximum automatic opening until building-local midnight. Further manual moves replace the remembered level. |

For example, add these settings to the native configuration:

```json
{
  "minimumSolarPowerPerWindowW": 20,
  "minMovementIntervalMinutes": 60,
  "minPositionChange": 10,
  "respectManualPositionUntilEndOfDay": true
}
```

The watt allowance is **per window**, rather than shared between windows. It is capped by the available sunlight: if a window can admit only 10 W while fully open, a 20 W setting leaves it fully open. The estimate is `GTI × glassArea × gValue × uncoveredFraction`; watts are a proxy for daylight, not a measurement of illuminance. Residual thermal transmission through a closed shutter does not count as daylight. The planner limits closing accordingly and includes the extra heat in the room forecast. `solarBudgetExceeded` reports an intentional or unavoidable excess instead of closing beyond the daylight limit. Manual holds, disabled controls and vacation schedules retain their operating priority.

The movement interval is also the **position-planning horizon**. With 60 minutes configured, the planner examines the full next hour of facade irradiance, including the expected sun direction, and chooses a position for that entire hold. Weak sun now followed by strong sun in 30 minutes therefore causes preventive shading now. A falling light forecast can require a more-open position now to preserve the daylight minimum later in the hour. The resulting held positions are checked against the full 24-hour RC temperature trajectory and heat budget. The durable last-command timestamp prevents restarting the adapter from resetting the interval. Manual operation remains available.

The position threshold uses **percentage points**, independently of the movement interval and motor feedback tolerance. Before checking the move size, an automatic target becomes **100% open** when `target + minPositionChange > 100`. With `minPositionChange: 10`, a target of 91% becomes 100%; a target of exactly 90% remains 90%. This also prevents closing an already open blind to 91–99%. A remembered manual opening ceiling still caps the result, and the forecast includes the snapped positions in its heat balance.

The minimum move size is then checked against the actual position. With `minPositionChange: 10`, 49 → 53 is ignored (4 points), 30 → 53 is performed (23 points), and 43 → 53 is performed (exactly 10 points), subject to the other operating permissions. An actual position of 89% with a planned target of 93% moves to the snapped target of 100% (11 points); an actual position of 95% with the same plan remains unchanged because the move to 100% would be only 5 points. The same rule applies to closing, daylight corrections, reopening after direct sun ends, and morning/vacation schedules. The forecast retains the actual position for ignored changes, and ignoring a change does not start a movement cooldown. Manual operation is unaffected. A daylight correction smaller than the threshold remains pending until a sufficiently large move is required.

When `respectManualPositionUntilEndOfDay` is enabled, a **confirmed manual position below the latest plan before the manual pause** becomes a window-local opening ceiling for the rest of the calendar day. If the plan was 50% and the user chooses 25%, automatic control can later close to 0%, then reopen to at most 25% when a new plan requests 75%. A later manual opening to 90% replaces the ceiling with 90%, even if that is above the current plan. Manually choosing 100% removes any practical opening restriction. A first manual move at or above the plan does not establish a ceiling; an explicit manual closing to 0% always does, including when the plan is unavailable or already 0%.

The existing manual pause of at least 60 minutes still comes first. After that pause, the minimum movement interval and change threshold still apply. The daily ceiling overrides automatic daylight reopening, reopening after direct sun ends and scheduled openings. Consequently, a manual 0% ceiling keeps the blind closed until the next day. Automatic movement and periodic feedback never replace the remembered manual preference. Unacknowledged requested targets alone do not establish the ceiling; confirmed motor feedback does.

The remembered ceiling and latest plan survive adapter restarts. The ceiling expires at **local midnight**, including on daylight-saving transition days; the next day's normal schedule can open the blind again. Midnight itself does not cause a move. Disabling the option clears remembered ceilings when configuration is reloaded. The room forecast respects each ceiling and its midnight expiry, including the effect on admitted heat. The all-open comparison remains hypothetical. The simulator exposes the same option and shows each active maximum opening on its window card.

### Runtime states

All IDs below are relative to `thermalblindcontrol.0`.

| State | Purpose |
| --- | --- |
| `global.enabled` | Persistent master enable, writable boolean |
| `global.disabledToday` | Disable until the next building-local midnight, writable boolean |
| `global.vacationMode` | Persistent vacation schedules and daytime thermal protection, writable boolean |
| `global.dryRun` | Suppress every motor command while publishing diagnostics, writable boolean |
| `global.operatingMode` | Current global mode |
| `global.forecastValid`, `lastForecastUpdate`, `forecastError` | Forecast coverage, age and refresh failure |
| `global.nextMorning`, `nextEvening` | Today's calculated event timestamps; a timestamp can already be past |
| `windows.<id>.enabled`, `autoMorningOpen` | Persistent per-window writable flags |
| `windows.<id>.participatingToday` | Today's normal thermal enrollment |
| `windows.<id>.manualOverrideActive`, `manualHoldUntil` | Manual hold and expiry |
| `windows.<id>.manualPositionLimit`, `manualPositionLimitActive` | Remembered maximum openness for today (`null` when inactive) and its activation flag; both read-only |
| `windows.<id>.actualPosition`, `calculatedPosition` | Percent open: 100 = open, 0 = closed; unavailable values are `null` |
| `windows.<id>.directSun`, `directIrradiance` | Current direct-sun eligibility and projected facade direct irradiance (W/m²) |
| `windows.<id>.controlReason`, `commandError` | Movement or blocking reason and last delivery error |
| `windows.<id>.lastOwnCommand` | Command identity, target, trajectory, timeout and completion |
| `rooms.<id>.currentTemperature` | Valid measured starting temperature |
| `rooms.<id>.climateBudget24h`, `climateIndex` | Gross climatic cooling budget (Wh), normalized index (K) |
| `rooms.<id>.solarPotential24h`, `solarAllowed24h` | All-open potential and admitted energy in the chosen plan (Wh) |
| `rooms.<id>.solarBudget24h`, `solarPowerTargetW` | Available solar budget (Wh) and the common admitted-power ceiling (W) |
| `rooms.<id>.solarBudgetExceeded` | Unavoidable heat or operating locks prevent meeting the solar budget |
| `rooms.<id>.heatingEnergyPredicted24h`, `residualHeatingPower` | Heuristic heating energy (Wh), current residual underfloor power (W) |
| `rooms.<id>.adaptiveTempLimit`, `predictedMaxTemp`, `openMaxTemp` | Comfort limit, planned peak and all-open baseline peak (°C) |
| `rooms.<id>.capacityWhK`, `timeConstantHours` | Effective capacity and C/H time constant |
| `rooms.<id>.unavoidableOverheating`, `modelQuality` | Infeasibility and model qualification |
| `rooms.<id>.temperaturePlan` | JSON time series of temperature, solar/heating power and per-window openness |
| `global.runtime`, `windows.<id>.runtime`, `rooms.<id>.runtime` | Read-only persistent internal state; do not edit |
| `info.connection`, `info.forecastCache` | Valid forecast available / persistent last complete forecast |

## Operating behavior

Master disable, disabled today and manual holds guard all automatic control. Vacation mode runs morning/evening schedules and daytime thermal protection regardless of individual enable, morning-opening or daily participation flags. Normal mode requires individual enable and daily participation for thermal control. Dry run additionally prevents every real motor command.

- **Manual actions:** foreign target writes, unexplained position changes, reversals and unassigned moving signals start a window-local hold of at least 60 minutes. Further changes extend it. A confirmed foreign opening of at least 90% enrolls that window for the day; merely being open at startup or requesting an open target does not. The manual hold still applies after enrollment, including in vacation mode.
- **Optional daily manual ceiling:** `respectManualPositionUntilEndOfDay` preserves a user's more-closed choice until local midnight. Later manual movements replace the ceiling; automatic movements leave it intact. `MANUAL_POSITION_LIMIT` identifies a target constrained by this preference.
- **Own movement:** persisted identity, source, target, timestamp, monotonic intermediate feedback and travel timeout distinguish expected feedback from manual actions. `ack` alone is not used as proof. An explicit unacknowledged command from another source is manual even if its target matches. Identical acknowledged target echoes inside an outstanding command's recognition interval cannot always be distinguished; use separate actual/target states when the device supports them.
- **Windows sharing a room:** matching sunlit windows share a proportional shading target. Expected feedback from one blind preserves the pending commands for its siblings. During an unfinished own movement, forecasts use its committed destination; actual-position diagnostics continue to show measured feedback. When the travel timeout expires, the next evaluation drops that assumption and recalculates using observed positions. Each blind still respects its own participation, manual holds, opening ceiling, movement interval and minimum change, so existing small position differences may remain until a sufficiently large move is needed.
- **Morning:** enabled opted-in windows open once within the morning event window. A successful command or an already-open blind marks participation. Thermal shading follows in a later evaluation, subject to the movement cooldown, so the two routines cannot issue opposite movements in one cycle.
- **Opted-out morning:** no normal commands before a confirmed external daily opening. Setting `autoMorningOpen=false` does not revoke participation already earned today.
- **Vacation:** all configured windows follow daytime thermal control even when `autoMorningOpen=false`, the individual `enabled` flag is false, or normal daily participation has not been earned. Morning and evening schedules remain active. The morning move uses the thermal target when active control and valid model data are available, avoiding full opening for a whole movement interval when shading is already needed; otherwise it requests 100% open. Evening closing requests 0%. Forecast and room-temperature availability are required for thermal protection, and `thermalMode=off` or `shadow` retains its normal meaning. The schedules remain available without model data. Global/daily disables, manual holds, daily manual opening ceilings and all movement guards still apply. Actual position must be valid. Vacation operation does not enroll a blind for normal mode.
- **Schedules:** sunrise/sunset plus offsets are clamped to morning 07:00–10:00 and evening 17:00–22:00 by default. If the sun event is unavailable, the latest bound is used. Events retry for 60 minutes, subject to holds. Switching vacation mode does not replay scheduled events from before the switch; daytime thermal control can start immediately. Expired events are skipped. In normal mode, missed morning enrollment waits for external opening or the next morning.
- **Normal evenings:** V1 does not automatically close blinds at night. Normal thermal movements are confined to the interval between the configured morning/evening events; positions are held outside it. Daily reset itself never causes a motor command.
- **Motion limits:** `minMovementIntervalMinutes` between automatic commands and at least `minPositionChange` percentage points per automatic change (default 10). Both apply to thermal, daylight and scheduled moves. Motor feedback tolerance only recognizes device feedback; it does not override the position threshold. Travel in progress blocks additional movement.
- **Restart:** restores control flags, dated daily disable, participation, manual holds, heating residual estimate and command identity; checks for observable offline position changes and waits 30 seconds before considering motor commands. No initial enrollment is inferred from a static open snapshot.
- **Command races:** manual actions and changed inputs invalidate pending commands after awaited database writes. Recognized own target echoes and motor feedback preserve the room's shared decision. Feedback bursts are checked in receive order so a reversal still cancels stale commands even before queued state processing catches up. Command intent is saved before hardware writes. A failed delivery keeps the cooldown because the motor might have received it; a diagnostic error is published. The next eligible evaluation computes a fresh decision.

## Thermal and forecast model

Open-Meteo hourly **global tilted irradiance** and **direct normal irradiance (DNI)** are requested at tilt 90° once per distinct orientation. Compass azimuths 70° / 160° / 250° become API azimuths −110° / −20° / +70°. Requests include three calendar days and Unix timestamps. GTI and DNI are means of the **preceding hour**; temperature uses the mean of the interval endpoints. The parser aligns them to intervals, then clips/splits them into steps of at most 15 minutes covering exactly 24 elapsed hours. Gaps, missing facades/DNI, implausible values, wrong units, stale bundles and overlaps invalidate thermal control. These conventions follow the [Open-Meteo API documentation](https://open-meteo.com/en/docs).

Direct-sun eligibility is separate from the heat model: DNI is projected onto each vertical facade using sun position. Only a sun above the horizon, in front of the facade, producing more than 5 W/m² of projected direct irradiance permits thermal closing. Diffuse/reflected GTI still enters the heat balance, but never enables closing by itself. Eligible unlit windows are opened again, respecting operating permissions and movement guards. The check is repeated when executing a command so a cached target cannot close a facade after the sun leaves it. Manual holds and independent vacation evening routines retain their operating priorities. Cached forecasts from the earlier version without DNI are discarded until a complete refresh succeeds.

Refresh is hourly. A failed refresh retains the last complete bundle only while its age and coverage remain valid (maximum age 180 minutes by default). Schedules remain available without forecasts. Invalid/stale room temperatures or missing positions also block thermal decisions; stale diagnostics are cleared. Forecast freshness is checked every minute. Sensor age and position age limits are separately configurable in minutes, using state `ts`, not last-change `lc`.

The model uses:

- `B = Σ H × (target − outside) × dt`; `K = B / (24 × H)`.
- `limit = target + toleranceMax × clamp((K − toleranceStart) / (toleranceFull − toleranceStart), 0, 1)`. Defaults reproduce the plan's 21–25°C curve. Tightening is immediate; relaxation is smoothed over 60 minutes.
- `C = floorArea × constructionCapacity`, using 22 / 31 / 46 / 72 / 103 Wh/(m²·K).
- Solar power `GTI × glassArea × gValue × transmission`. Initial transmission is linear from 1 open to 0.05 closed, configurable per window.
- The exact discrete one-zone RC step, starting at the measured room temperature, with internal gains and estimated heating power.

The optimizer allocates solar heat **before the budget is spent**. The available solar budget is `max(0, climateBudget24h + C × (adaptiveLimit − measuredTemperature) − internalEnergy − predictedHeatingEnergy)`. It searches for the largest common admitted solar-power ceiling whose complete RC temperature trajectory and energy total fit the available capacity. Each trial simulates the existing heating response, manual holds, disabled windows, movement interval, daylight floor and minimum position change. Each permitted position considers the strongest forecast exposure before the next permitted move; its maximum closing also preserves daylight across that interval. An already overheated room first rejects additional heat while cooling, subject to the daylight allowance; later hours can use the remaining budget once the room recovers.

The requested profile is approximately `admittedPower(t) = min(availablePower(t), roomPowerTarget)`. When sunlight is weak, windows stay more open; during intense hours, sunlit windows close further. Simultaneously sunlit, movable windows share the required reduction in proportion to their removable solar power. Targets have one-percent resolution, subject to movement hysteresis. When 50% openness suffices, the controller holds the blind at 50% open during the relevant hours. Stronger shading lowers the position toward 0; opening raises it toward 100. Solar energy from unlit or locked windows is included as an unavoidable floor; if that floor alone exceeds the budget, `solarBudgetExceeded` reports the conflict and unlit windows remain open.

The planner applies only the first step and recalculates every 15 minutes or after relevant input changes. It is a forecast-based heuristic; thermal limits, changes in facade exposure, discrete movement guards and manual operation can prevent a perfectly flat power curve. The old beam-search weighting settings (`temperatureWeight`, `blockedSolarWeight`, `movementWeight`) are no longer used or offered in Admin; saved copies are harmless and ignored.

`solarAllowed24h` reports the selected plan's admitted solar energy; it does not promise the comfort target is achievable. Negative budgets or a too-hot starting room may make overheating unavoidable even with complete shading. The all-open reference is hypothetical and can disregard operating locks. The planned trajectory can also be blocked by global controls, shadow mode or schedule hours; it is a model diagnostic, not a record of executed commands.

Radiator power is an uncertain estimate using configured nominal power, a nonlinear valve factor, central water-temperature level and assumed existing thermostat response. It decreases as solar heat raises room temperature. Missing demand/valve evidence does not invent an always-on heat source. Underfloor heating uses a first-order residual source whose warmth decays after demand turns off. Across long observation outages, stored residual heat decays rather than assuming unobserved continuous input. Neither valve position nor central water temperature is treated as measured room watts.

## Scope and remaining calibration

V1 implements phases 1–3 of the plan. The plan's undecided points use explicit defaults: 21°C is a soft comfort reference, maximum winter tolerance is 4 K, opening means at least 90% open, shading transmission starts linear, and normal evenings have no closing routine. There is no independent hard temperature safety controller or minimum-temperature heating intervention.

Phase 4 learning of H/C and heating parameters, geometric shading, external obstructions, open-window ventilation, randomized vacation occupancy and alternative forecast providers are not implemented. The thermal/heating parameters need comparison with measured room histories before relying on active control. Open-Meteo network access is used only by the real adapter, and its [usage terms](https://open-meteo.com/en/terms) must suit the deployment.

## Development and validation

For the deployed InfluxDB history configuration, Grafana dashboard and reusable setup scripts, see [InfluxDB history and Grafana debugging](observability/README.md).

```sh
npm test
npm run admin:generate  # regenerate native defaults and Admin configuration
npm pack
```

The Node test suite covers the plan's 14 acceptance categories: permissions and vacation precedence; per-window enrollment and holds; own feedback; winter/hot-period modeling; radiator substitution and floor residual heat; forecast failure; DST and rolling coverage; independent rooms/windows. Solar-allocation regressions cover exactly 50% shading when sufficient, preventive shading while still cool, equal admitted power under weak/strong sun, direct-sun-only closing, missing DNI and full-day playback. They also check per-window daylight despite an exhausted budget, low available light, advance shading for sun intensifying within the next hour, and preservation of daylight while it fades during the hold. In-memory adapter tests additionally cover persistence-before-command, startup, shared IDs, state acknowledgements, stale-input cancellation, failed motor writes, invalid sensor data and hourly movement intervals across restart. Tests never write real device states.

Modules: `config.ts` (validation and normalization), `time.ts` (timezone/sun schedules), `weather.ts` (fetch/parser/grid), `thermal.ts` (RC/heating/optimization), `engine.ts` (operating rules/feedback), `main.ts` (ioBroker integration), `simulator.ts` (virtual sensors and plant). Admin configuration follows the [ioBroker JSON Config documentation](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md).
