const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, roomDefaults, heatingDefaults, windowDefaults, parseConfig, migrateLegacyConfig, automaticPosition } = require('../build/lib/config');
const admin = require('../admin/jsonConfig.json');
const roomSchema = admin.items._Rooms.items.rooms;
const room = (overrides = {}) => ({ ...structuredClone(roomDefaults), id: 'eg_gast', temperatureSensorId: 'room.temperature', ...overrides });
const config = rooms => ({ ...structuredClone(defaults), rooms });

// Admin's accordion assigns a literal attr to the row, then passes that same
// array to ConfigGeneric.onChange. Its calculateFunc must also repair the array
// in place: the accordion renders and exports its local array after the edit.
function editRooms(rows, edit) {
    const localRows = structuredClone(rows);
    edit(localRows);
    const data = { rooms: localRows };
    const source = roomSchema.onChange?.calculateFunc;
    if (source) data.rooms = new Function('data', source.includes('return') ? source : `return ${source}`)(data);
    return { saved: data.rooms, exported: localRows };
}

test('Admin heating edits update nested values, export cleanly and survive reopening', () => {
    const edits = { type: 'underfloor', setpointId: 'heating.setpoint', demandId: 'heating.demand',
        valvePositionId: 'heating.valve', nominalPowerW: 150, residualTimeHours: 8 };
    let rows = [room(), room({ id: 'other', temperatureSensorId: 'other.temperature' })];
    const untouched = structuredClone(rows[1]);
    for (const [key, value] of Object.entries(edits)) {
        const field = roomSchema.items.find(item => item.attr === `heating.${key}`);
        assert(field, `missing heating field ${key}`);
        const { saved, exported } = editRooms(rows, rows => { rows[0][field.attr] = value; });
        assert.equal(saved[0].heating[key], value, key);
        assert.equal(exported[0].heating[key], value, `accordion export: ${key}`);
        assert(!Object.keys(saved[0]).some(key => key.startsWith('heating.')));
        assert.deepEqual(saved[1], untouched);
        rows = JSON.parse(JSON.stringify(saved));
        assert.equal(parseConfig(config(rows)).rooms[0].heating[key], value, `backend: ${key}`);
    }
    assert.deepEqual(rows[0].heating, edits);
    const { saved } = editRooms(rows, rows => {
        rows[0]['heating.nominalPowerW'] = 0;
        rows[0]['heating.setpointId'] = '';
    });
    assert.equal(saved[0].heating.nominalPowerW, 0);
    assert.equal(saved[0].heating.setpointId, '');
});

test('Admin adding a room creates nested heating defaults', () => {
    const added = Object.fromEntries(roomSchema.items.filter(item => item.attr).map(item => [item.attr, structuredClone(item.default)]));
    const { saved, exported } = editRooms([], rows => rows.push(added));
    assert.deepEqual(saved[0].heating, heatingDefaults);
    assert.deepEqual(exported, saved);
    assert(!Object.keys(exported[0]).some(key => key.startsWith('heating.')));
});

test('legacy dotted room edits override stale nested settings without mutating the input', () => {
    const input = config([room({ heating: { ...heatingDefaults, type: 'underfloor', nominalPowerW: 1500 },
        'heating.nominalPowerW': 150, 'heating.setpointId': 'heating.newSetpoint', 'heating.residualTimeHours': 8 })]);
    const original = structuredClone(input);
    const parsed = parseConfig(input);
    assert.equal(parsed.rooms[0].heating.nominalPowerW, 150);
    assert.equal(parsed.rooms[0].heating.setpointId, 'heating.newSetpoint');
    assert.equal(parsed.rooms[0].heating.residualTimeHours, 8);
    assert(!Object.keys(parsed.rooms[0]).some(key => key.startsWith('heating.')));
    assert.deepEqual(input, original);
    assert.deepEqual(parseConfig(parsed), parsed);
});

test('flat-only imports and zero/empty overrides retain the same heating settings as nested imports', () => {
    const heating = { type: 'radiator', setpointId: '', demandId: 'heating.demand', valvePositionId: '', nominalPowerW: 0, residualTimeHours: 0.25 };
    const flat = room(Object.fromEntries(Object.entries(heating).map(([key, value]) => [`heating.${key}`, value])));
    delete flat.heating;
    assert.deepEqual(parseConfig(config([flat])), parseConfig(config([room({ heating })])));
});

test('legacy central heating fields are normalized and removed', () => {
    const input = { ...config([room()]), centralHeating: { flowTemperatureId: 'heating.oldFlow', returnTemperatureId: 'heating.oldReturn' },
        'centralHeating.flowTemperatureId': 'heating.newFlow', 'centralHeating.returnTemperatureId': '' };
    const parsed = parseConfig(input);
    assert.deepEqual(parsed.centralHeating, { flowTemperatureId: 'heating.newFlow', returnTemperatureId: '' });
    assert(!Object.keys(parsed).some(key => key.startsWith('centralHeating.')));
});

test('legacy edits undergo heating validation and actuator/input collision checks', () => {
    for (const override of [{ 'heating.nominalPowerW': -1 }, { 'heating.residualTimeHours': 0 },
        { 'heating.type': 'invalid' }, { 'heating.setpointId': 'invalid state' }]) {
        assert.throws(() => parseConfig(config([room(override)])));
    }
    assert.throws(() => parseConfig({ ...config([room({ 'heating.demandId': 'blind.target' })]),
        windows: [{ ...windowDefaults, id: 'blind', roomId: 'eg_gast', positionStateId: 'blind.actual', positionCommandId: 'blind.target' }] }),
    /A blind command must never target/);
});

test('allowed positions normalize numeric Admin chips without mutating the saved list', () => {
    const raw = ['20', 0, '100', 80, '10', 40, 60, '20'];
    const before = structuredClone(raw);
    const c = parseConfig({ allowedPositions: raw });
    assert.deepEqual(c.allowedPositions, [100, 80, 60, 40, 20, 10, 0]);
    assert.deepEqual(raw, before);
    assert.deepEqual(parseConfig(c), c);
    for (const [requested, expected] of [[17, 20], [20, 20], [1, 10], [0, 0], [100, 100], [20.01, 40]])
        assert.equal(automaticPosition(requested, c.allowedPositions), expected);
    assert.equal(automaticPosition(100, c.allowedPositions, 35), 20);
});

test('allowed positions reject malformed lists and require both schedule endpoints', () => {
    for (const allowedPositions of [undefined, null, '', '100, 20, 0', 20, {}, [], [0], [100], [20, 80],
        [100, -1, 0], [100, 101, 0], [100, NaN, 0], [100, Infinity, 0], [100, null, 0],
        [100, true, 0], [100, '', 0], [100, ' ', 0], [100, 'invalid', 0], [100, {}, 0], [100, [], 0]])
        assert.throws(() => parseConfig({ allowedPositions }), /allowedPositions/);
    assert.deepEqual(parseConfig({}).allowedPositions, [100, 80, 60, 40, 20, 10, 0]);
});

test('saved minimum movement settings migrate once to allowed positions without changing other settings', () => {
    for (const legacy of [{ minPositionChange: 10 }, { global: { minPositionChange: 99, enabled: true } },
        { minPositionChange: 'obsolete', global: { minPositionChange: 0 } }]) {
        const raw = { ...legacy, extraSetting: 'preserved' }, before = structuredClone(raw);
        const migrated = migrateLegacyConfig(raw);
        assert.deepEqual(migrated.allowedPositions, defaults.allowedPositions);
        assert(!Object.hasOwn(migrated, 'minPositionChange'));
        assert(!migrated.global || !Object.hasOwn(migrated.global, 'minPositionChange'));
        assert.equal(migrated.extraSetting, 'preserved');
        assert.deepEqual(raw, before);
        assert.equal(migrateLegacyConfig(migrated), migrated, 'clean configuration must not cause repeated saves');
        assert.deepEqual(parseConfig(raw).allowedPositions, defaults.allowedPositions);
    }
    const custom = [100, 75, 25, 0];
    assert.deepEqual(parseConfig({ minPositionChange: 10, allowedPositions: custom }).allowedPositions, custom);
    assert.deepEqual(parseConfig({ minPositionChange: 10, global: { allowedPositions: custom } }).allowedPositions, custom);
});

test('Admin exposes an editable allowed-position list and validates its array values', () => {
    const general = admin.items._General.items;
    assert(!Object.hasOwn(general, 'minPositionChange'));
    assert.equal(general.allowedPositions.type, 'chips');
    assert.deepEqual(general.allowedPositions.default, defaults.allowedPositions);
    const valid = new Function('data', `return ${general.allowedPositions.validator}`);
    for (const allowedPositions of [defaults.allowedPositions, ['100', '20', '0'], [0, 37.5, 100]]) {
        assert(valid({ allowedPositions }));
        assert.doesNotThrow(() => parseConfig({ allowedPositions }));
    }
    for (const allowedPositions of [[], [100], [0, 20], [100, '', 0], [100, true, 0], [100, 101, 0]])
        assert(!valid({ allowedPositions }));
});
