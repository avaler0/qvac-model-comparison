import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { execFile, fork } from 'node:child_process';
import { runPanels } from './sequential.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isDev = !app.isPackaged;
let window;
let sdk;
let catalog = [];
let download = null;
let run = null;
let quitting = false;
const contextSize = 4096;
const settings = Object.freeze({ temp: 0.7, top_p: 0.9, predict: 2048, seed: 42, reasoning_budget: 0 });

function cacheDirectory() { return path.join(app.getPath('home'), '.qvac', 'models'); }
function configureSdk() {
  const dir = cacheDirectory();
  mkdirSync(dir, { recursive: true });
  const config = path.join(app.getPath('userData'), 'qvac.config.json');
  writeFileSync(config, JSON.stringify({ cacheDirectory: dir, loggerConsoleOutput: false, loggerLevel: 'off' }));
  process.env.QVAC_CONFIG_PATH = config;
}
async function qvac() {
  if (!sdk) {
    const moduleRoot = app.isPackaged ? `${root}.unpacked` : root;
    sdk = await import(pathToFileURL(path.join(moduleRoot, 'node_modules', '@qvac', 'sdk', 'dist', 'src', 'index.js')).href);
  }
  return sdk;
}
function send(event) { if (!window?.isDestroyed()) window.webContents.send('compare:event', event); }
function publicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\/[\w.\-/]+/g, '[path]');
}
function builtinCatalog(q) {
  const seen = new Set();
  return Object.values(q).filter(d => {
    if (!d || typeof d !== 'object' || d.addon !== 'llm' || d.engine !== 'llamacpp-completion' ||
        typeof d.src !== 'string' || !d.src.toLowerCase().endsWith('.gguf') ||
        /multimodal|shard|tensor/i.test(d.name) || seen.has(d.src)) return false;
    seen.add(d.src);
    return true;
  }).sort((a,b) => a.expectedSize - b.expectedSize).map(d => ({
    id: d.name, name: d.modelId, quantization: d.quantization, size: d.expectedSize,
    source: d.src, descriptor: d, kind: 'registry', status: 'checking'
  }));
}
async function refreshCatalog() {
  const q = await qvac();
  if (!catalog.length) {
    catalog = builtinCatalog(q);
    send({ type: 'catalog', models: catalog.map(publicModel) });
  }
  const registry = catalog.filter(m => m.kind === 'registry');
  for (let index = 0; index < registry.length; index += 8) {
    await Promise.all(registry.slice(index,index+8).map(async model => {
    try {
      const info = await q.getModelInfo({ name: model.id });
      model.info = info;
      model.status = info.isCached && info.cacheFiles.every(f => f.isCached)
        ? 'available' : info.cacheFiles.some(f => f.actualSize > 0) ? 'partial' : 'download';
      model.size = info.expectedSize;
    } catch { model.status = 'unknown'; }
    }));
    send({ type: 'catalog', models: catalog.map(publicModel) });
  }
  send({ type: 'catalog', models: catalog.map(publicModel) });
  return catalog.map(publicModel);
}
function publicModel(m) {
  return { id: m.id, name: m.name, quantization: m.quantization, size: m.size,
    kind: m.kind, status: m.status, path: m.kind === 'local' ? m.path : undefined,
    assets: m.info?.cacheFiles.map(f => ({ name: f.filename, size: f.expectedSize, ready: f.isCached })) ?? [] };
}
async function inspectLocal(file) {
  if (!file.toLowerCase().endsWith('.gguf')) throw Error('Choose a GGUF model file.');
  if (/[-.]\d{5}-of-\d{5}\.gguf$/i.test(file)) throw Error('Sharded GGUF bundles are not supported as local files in this release.');
  const handle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
  try {
    const bytes = Buffer.alloc(4);
    await handle.read(bytes, 0, 4, 0);
    if (bytes.toString() !== 'GGUF') throw Error('This file is not a GGUF model.');
    const size = (await handle.stat()).size;
    if (size < 1024) throw Error('The GGUF file appears incomplete.');
    return size;
  } finally { await handle.close(); }
}
async function checksum(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function preflight(model) {
  if (model.kind === 'local') {
    await inspectLocal(model.path);
    return model.path;
  }
  const q = await qvac();
  const info = await q.getModelInfo({ name: model.id });
  if (!info.isCached || !info.cacheFiles.length) throw Error('Model assets are missing. Select the model and approve the download.');
  for (const file of info.cacheFiles) {
    const s = await stat(file.path).catch(() => null);
    if (!file.isCached || s?.size !== file.expectedSize) throw Error(`Missing or incomplete companion asset: ${file.filename}`);
    if (file.sha256Checksum && await checksum(file.path) !== file.sha256Checksum.toLowerCase())
      throw Error(`Checksum failed for ${file.filename}. Download the model again.`);
  }
  if (info.cacheFiles.length !== 1) throw Error('This registry model needs multiple files; local offline loading is not yet verified for this artifact set.');
  return info.cacheFiles[0].path;
}
function assertIdle() { if (run || download) throw Error('Finish or stop the current operation first.'); }

function sampleWorkerTree(rootPid, callback) {
  if (process.platform !== 'darwin') return () => {};
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 2000 }, (error, stdout) => {
      pending = false;
      if (error) return;
      const rows = stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number))
        .filter(row => row.length === 3 && row.every(Number.isFinite));
      const pids = new Set([rootPid]);
      let changed;
      do {
        changed = false;
        for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); changed = true; }
      } while (changed);
      const rss = rows.filter(([pid]) => pids.has(pid)).reduce((sum, [, , kb]) => sum + kb * 1024, 0);
      if (rss) callback(rss);
    });
  }, 250);
  return () => clearInterval(timer);
}

function startWorker(runId, panel, modelPath) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(root, 'electron', 'worker.mjs'), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let done = false;
    let error = null;
    const started = performance.now();
    let peakWorkerTreeRss = 0;
    const stopSampling = sampleWorkerTree(child.pid, rss => { peakWorkerTreeRss = Math.max(peakWorkerTreeRss, rss); });
    run.child = child;
    child.on('message', event => {
      if (event.type === 'worker:error') error = event.message;
      else if (run?.id === runId) send({ ...event, runId, panel });
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      stopSampling();
      done = true;
      run.child = null;
      const totalMs = performance.now() - started;
      if (run?.id === runId) send({ type: 'total', runId, panel, totalMs, peakWorkerTreeRss: peakWorkerTreeRss || null });
      if (error || (code !== 0 && !run?.cancelled)) reject(Error(error || `Inference process exited (${code ?? signal}).`));
      else resolve();
    });
    child.send({ type: 'start', modelPath, prompt: run.prompt, settings, contextSize });
    run.kill = () => {
      if (done) return;
      child.send({ type: 'stop' });
      setTimeout(() => { if (!done) child.kill('SIGTERM'); }, 3000).unref();
      setTimeout(() => { if (!done) child.kill('SIGKILL'); }, 8000).unref();
    };
  });
}
async function compare(request) {
  assertIdle();
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || !Array.isArray(request.models) || request.models.length !== 2)
    throw Error('Enter a prompt and choose two ready models.');
  const models = request.models.map(id => catalog.find(m => m.id === id));
  if (models.some(m => !m)) throw Error('Selected model is no longer available.');
  const id = crypto.randomUUID();
  run = { id, prompt: request.prompt, cancelled: false, child: null, kill: null };
  send({ type: 'comparison', runId: id, state: 'preflight' });
  let preflightPanel = null;
  try {
    const verified = new Map();
    const paths = [];
    for (const [index, m] of models.entries()) {
      if (run.cancelled) break;
      preflightPanel = index === 0 ? 'A' : 'B';
      if (!verified.has(m.id)) verified.set(m.id, await preflight(m));
      paths.push(verified.get(m.id));
    }
    preflightPanel = null;
    if (run.cancelled) { send({ type: 'comparison', runId: id, state: 'cancelled' }); return id; }
    try {
      const fit = await (await qvac()).assessModelFit({
        models: paths.map(modelSrc => ({ modelSrc, modelType: 'llamacpp-completion', modelConfig: { ctx_size: contextSize } })),
        execution: 'sequential'
      });
      if (fit.verdict === 'likely-too-large') send({ type: 'notice', message: 'QVAC estimates these models may exceed available memory. Loading may fail; consider smaller models.' });
      if (fit.verdict === 'unknown') send({ type: 'notice', message: 'QVAC could not estimate model fit. The run may fail if memory is insufficient.' });
    } catch (error) {
      send({ type: 'notice', message: 'Model fit could not be assessed. The run may fail if memory is insufficient.' });
    }
    if (run.cancelled) { send({ type: 'comparison', runId: id, state: 'cancelled' }); return id; }
    const result = await runPanels({ paths,
      start: (panel, modelPath) => startWorker(id, panel, modelPath),
      cancelled: () => run.cancelled,
      state: value => send({ type: 'comparison', runId: id, state: value }),
      error: (panel, error) => send({ type: 'panel', runId: id, panel, state: 'error', message: publicError(error) }) });
    send({ type: 'comparison', runId: id, state: result });
  } catch (error) {
    if (preflightPanel && !run.cancelled) send({ type: 'panel', runId: id, panel: preflightPanel, state: 'error', message: publicError(error) });
    send({ type: 'comparison', runId: id, state: run.cancelled ? 'cancelled' : 'failed', message: publicError(error) });
  } finally { run = null; }
  return id;
}

app.whenReady().then(async () => {
  configureSdk();
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 650, minHeight: 600,
    backgroundColor: '#0F1010', webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (isDev) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(root, 'dist', 'index.html'));
  refreshCatalog().catch(error => send({ type: 'notice', message: publicError(error) }));
});
app.on('before-quit', event => {
  if (quitting || (!run && !download)) return;
  event.preventDefault();
  quitting = true;
  if (download) { download.stop(); download = null; }
  if (run) { run.cancelled = true; run.kill?.(); }
  const deadline = Date.now() + 9000;
  const wait = setInterval(() => { if ((!run && !download) || Date.now() > deadline) { clearInterval(wait); app.quit(); } }, 100);
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('catalog:list', () => refreshCatalog());
ipcMain.handle('model:choose', async () => {
  assertIdle();
  const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
  if (result.canceled) return null;
  const file = result.filePaths[0];
  const size = await inspectLocal(file);
  const id = crypto.randomUUID();
  const model = { id, name: path.basename(file), quantization: 'Unknown', size, kind: 'local', path: file, status: 'local' };
  catalog.push(model);
  send({ type: 'catalog', models: catalog.map(publicModel) });
  return publicModel(model);
});
ipcMain.handle('model:download', async (_event, id) => {
  assertIdle();
  const model = catalog.find(m => m.id === id && m.kind === 'registry');
  if (!model) throw Error('Unknown registry model.');
  const info = await (await qvac()).getModelInfo({ name: id });
  const missing = info.cacheFiles.filter(f => !f.isCached);
  const plan = { id, name: model.name, source: model.source, size: missing.every(f => Number.isFinite(f.expectedSize))
    ? missing.reduce((n, f) => n + Math.max(0, f.expectedSize - (f.actualSize || 0)), 0) : null,
    destination: cacheDirectory(), assets: missing.map(f => f.filename), resume: missing.some(f => f.actualSize > 0) };
  const free = await import('node:fs/promises').then(fs => fs.statfs(cacheDirectory())).then(s => s.bavail * s.bsize).catch(() => null);
  const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', plan.resume ? 'Resume download' : 'Download model'], defaultId: 0, cancelId: 0,
    title: plan.resume ? 'Resume model download?' : 'Download model?',
    message: `${plan.name}\n${plan.resume ? 'Resume' : 'Download'} ${Number.isFinite(plan.size) ? (plan.size / 1e9).toFixed(2) + ' GB' : 'Size unavailable'} to ${plan.destination}?`,
    detail: `Source: ${plan.source}\nRequired assets: ${plan.assets.join(', ') || 'Model file'}\nAvailable disk space: ${free == null ? 'Unavailable' : (free / 1e9).toFixed(2) + ' GB'}\nNo transfer starts unless you approve.` });
  if (response !== 1) return false;
  if (free != null && plan.size != null && free < plan.size) throw Error('Insufficient disk space for this model. Free space or choose another model.');
  const q = await qvac();
  const operation = q.downloadAsset({ assetSrc: model.descriptor, onProgress: p => send({ type: 'download', id, status: 'downloading', downloaded: p.downloaded, total: p.total }) });
  download = { id, stop: () => q.cancel({ requestId: operation.requestId }).catch(() => {}) };
  send({ type: 'download', id, status: 'downloading', downloaded: 0, total: plan.size });
  try {
    await operation;
    send({ type: 'download', id, status: 'verifying' });
    await refreshCatalog();
    if (model.status !== 'available') throw Error('Download finished, but required assets did not verify.');
    send({ type: 'download', id, status: 'available' });
    return true;
  } catch (error) {
    send({ type: 'download', id, status: 'partial', message: publicError(error) });
    return false;
  } finally { download = null; }
});
ipcMain.handle('model:pause', async () => { if (download) download.stop(); });
ipcMain.handle('comparison:start', (_event, request) => compare(request));
ipcMain.handle('comparison:stop', async () => { if (run) { run.cancelled = true; send({ type: 'comparison', runId: run.id, state: 'cancelling' }); run.kill?.(); } });
