#!/usr/bin/env node
'use strict';

// Run inside the ioBroker container. The default is a read-only preview.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const installed = createRequire('/opt/iobroker/package.json');
const connection = JSON.parse(fs.readFileSync('/opt/iobroker/iobroker-data/iobroker.json', 'utf8'));
const apply = process.argv.includes('--apply');
const namespace = 'thermalblindcontrol.0';
const history = 'influxdb.0';

function connect(kind) {
    return new Promise((resolve, reject) => {
        const { Client } = installed(`@iobroker/db-${kind}-${connection[kind].type}`);
        const timeout = setTimeout(() => reject(new Error(`${kind} connection timed out`)), 15000);
        const client = new Client({ connection: connection[kind], connected: () => { clearTimeout(timeout); resolve(client); } });
    });
}

(async () => {
    const objects = await connect('objects'), states = await connect('states');
    try {
        const instance = await objects.getObjectAsync(`system.adapter.${namespace}`);
        if (!instance?.native?.rooms?.length || !instance.native.windows?.length) throw new Error('Configured rooms and windows are required');
        if (!(await states.getStateAsync(`system.adapter.${history}.alive`))?.val) throw new Error('influxdb.0 must be running');
        const config = instance.native;
        const rows = await objects.getObjectListAsync({ startkey: `${namespace}.`, endkey: `${namespace}.\u9999`, include_docs: true });
        const selected = new Map(rows.rows.map(row => row.doc || row.value).filter(o => o.type === 'state').map(o => [o._id, o]));
        const inputs = [...new Set([
            ...config.rooms.flatMap(r => [r.temperatureSensorId, r.heating.setpointId, r.heating.demandId, r.heating.valvePositionId]),
            ...config.windows.flatMap(w => [w.positionStateId, w.positionCommandId, w.movementStateId]),
            ...Object.values(config.centralHeating),
            ...['alive', 'connected', 'cpu', 'memRss', 'memHeapUsed', 'eventLoopLag', 'uptime'].map(key => `system.adapter.${namespace}.${key}`),
        ].filter(Boolean))];
        for (const id of inputs) {
            const object = await objects.getObjectAsync(id);
            if (object?.type === 'state') selected.set(id, object);
            else throw new Error(`Configured input state does not exist: ${id}`);
        }
        const plan = [], currentStates = {};
        for (const object of selected.values()) {
            const id = object._id, existing = object.common.custom?.[history];
            currentStates[id] = await states.getStateAsync(id);
            const preserve = !id.startsWith(`${namespace}.`) && existing?.enabled === true;
            const largeJson = /\.(runtime|forecastCache|temperaturePlan)$/.test(id);
            const command = id.endsWith('.lastOwnCommand');
            const options = preserve ? existing : {
                ...existing,
                enabled: true,
                storageType: object.common.type === 'string' ? 'String' : 'Number',
                aliasId: existing?.aliasId || '',
                debounce: 0, debounceTime: 0, blockTime: 0,
                changesOnly: true,
                changesRelogInterval: command ? 0 : largeJson ? 3600 : 300,
                changesMinDelta: 0,
                ignoreZero: false, ignoreBelowZero: false,
                ignoreBelowNumber: '', ignoreAboveNumber: '',
                disableSkippedValueLogging: command,
                enableDebugLogs: false,
            };
            plan.push({ id, type: object.common.type, measurement: options.aliasId || id, action: preserve ? 'preserve' : 'enable', options });
        }
        const directory = path.join('/opt/iobroker/iobroker-data/thermalblindcontrol-observability', new Date().toISOString().replace(/[:.]/g, '-'));
        if (apply) {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify({ instance, objects: [...selected.values()], states: currentStates }, null, 2), { mode: 0o600 });
            fs.writeFileSync(path.join(directory, 'history-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
            for (const entry of plan) if (entry.action === 'enable') {
                await objects.extendObjectAsync(entry.id, { common: { custom: { [history]: entry.options } } });
            }
            for (const entry of plan) {
                const saved = (await objects.getObjectAsync(entry.id)).common.custom?.[history];
                if (!saved?.enabled) throw new Error(`History verification failed: ${entry.id}`);
                if (entry.action === 'enable' && (saved.debounceTime !== 0 || !saved.changesOnly || saved.storageType !== entry.options.storageType)) throw new Error(`Settings verification failed: ${entry.id}`);
            }
        }
        console.log(JSON.stringify({ applied: apply, namespace, history, rooms: config.rooms.length, windows: config.windows.length,
            total: plan.length, enabled: plan.filter(p => p.action === 'enable').length, preserved: plan.filter(p => p.action === 'preserve').length,
            byType: Object.fromEntries(['number', 'boolean', 'string'].map(type => [type, plan.filter(p => p.type === type).length])),
            backupDirectory: apply ? directory : null, plan }, null, 2));
    } finally { await states.destroy(); await objects.destroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
