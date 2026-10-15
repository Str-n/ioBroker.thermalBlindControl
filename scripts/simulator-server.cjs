#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.join(__dirname, '..');
// Source checkout: build before serving. Installed packages already contain build/ and need no dev dependencies.
if (fs.existsSync(path.join(project, 'src/main.ts'))) {
    const compiler = path.join(project, 'node_modules/typescript/bin/tsc');
    if (!fs.existsSync(compiler)) { process.stderr.write('Install dependencies with npm ci before starting the simulator.\n'); process.exit(1); }
    const build = spawnSync(process.execPath, [compiler], { cwd: project, stdio: 'inherit' });
    if (build.status !== 0) process.exit(build.status || 1);
}
const { simulate, demoConfig } = require('../build/lib/simulator');
const root = path.join(__dirname, '..', 'admin');
const host = '127.0.0.1';
const port = Number(process.env.THERMALBLINDCONTROL_SIMULATOR_PORT || 4174);
const assets = { '/': ['simulator.html', 'text/html'], '/simulator.js': ['simulator.js', 'text/javascript'], '/simulator.css': ['simulator.css', 'text/css'] };
function send(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
    res.end(body);
}
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
        const [file, type] = assets[req.url]; return send(res, 200, type, fs.readFileSync(path.join(root, file)));
    }
    if (req.method === 'GET' && req.url === '/api/config') return send(res, 200, 'application/json', JSON.stringify(demoConfig));
    if (req.method === 'POST' && req.url === '/api/simulate') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, 'application/json', '{"error":"Origin not allowed"}');
        let body = ''; req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > 512 * 1024 && !res.writableEnded) { send(res, 413, 'application/json', '{"error":"Request too large"}'); req.destroy(); }
        });
        req.on('end', () => {
            if (res.writableEnded) return;
            try { send(res, 200, 'application/json', JSON.stringify(simulate(JSON.parse(body)))); }
            catch (error) { send(res, 400, 'application/json', JSON.stringify({ error: String(error.message || error) })); }
        });
        return;
    }
    send(res, 404, 'text/plain', 'Not found');
});
server.requestTimeout = 15000;
server.on('error', error => { process.stderr.write(`Simulator could not listen on ${host}:${port}: ${error.message}\n`); process.exitCode = 1; });
server.listen(port, host, () => process.stdout.write(`Thermal blind control simulator: http://${host}:${port}\nSynthetic weather and virtual motors; no ioBroker connection. Ctrl+C to stop.\n`));
