import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

let stopped = false;
let activeRequest = null;
let sdk = null;
let modelId = null;
let sampling = null;
let peakRss = 0;
let finalState = 'completed';
let finalMessage = null;
const emit = event => { if (process.send) process.send(event); };
const errorMessage = error => (error instanceof Error ? error.message : String(error)).replaceAll(/\/[\w.\-/]+/g, '[path]');
const state = value => emit({ type: 'panel', state: value });

async function execute({ modelPath, prompt, settings, contextSize }) {
  const started = performance.now();
  sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 250);
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const moduleRoot = root.endsWith('app.asar') ? `${root}.unpacked` : root;
    sdk = await import(pathToFileURL(path.join(moduleRoot, 'node_modules', '@qvac', 'sdk', 'dist', 'src', 'index.js')).href);
    if (stopped) return;
    state('loading');
    const loadStart = performance.now();
    const load = sdk.loadModel({ modelSrc: modelPath, modelType: 'llamacpp-completion', modelConfig: { ctx_size: contextSize } });
    activeRequest = load.requestId;
    modelId = await load;
    activeRequest = null;
    const loadMs = performance.now() - loadStart;
    emit({ type: 'metrics', metrics: { loadMs, peakRss, settings, contextSize, sdkVersion: '0.22.0', backend: 'llamacpp-completion' } });
    if (stopped) return;
    state('generating');
    const submitted = performance.now();
    let firstOutput = null;
    let lastOutput = null;
    const run = sdk.completion({ modelId, history: [{ role: 'user', content: prompt }], stream: true,
      captureThinking: true, generationParams: settings });
    activeRequest = run.requestId;
    for await (const event of run.events) {
      if (stopped) break;
      if (event.type === 'contentDelta' && event.text) {
        const now = performance.now();
        firstOutput ??= now;
        lastOutput = now;
        emit({ type: 'delta', text: event.text });
      }
      if (event.type === 'completionStats') emit({ type: 'metrics', metrics: { inputTokens: event.stats.promptTokens, outputTokens: event.stats.generatedTokens,
        sdkTokensPerSecond: event.stats.tokensPerSecond, device: event.stats.backendDevice, peakRss } });
    }
    const final = await run.final;
    activeRequest = null;
    const inferenceMs = performance.now() - submitted;
    emit({ type: 'metrics', metrics: { inferenceMs, firstOutputMs: firstOutput === null ? null : firstOutput - submitted,
      outputWindowMs: firstOutput === null || lastOutput === null ? null : lastOutput - firstOutput,
      inputTokens: final.stats?.promptTokens, outputTokens: final.stats?.generatedTokens,
      sdkTokensPerSecond: final.stats?.tokensPerSecond, device: final.stats?.backendDevice, peakRss,
      partial: stopped || final.stopReason === 'cancelled' } });
    if (final.stopReason === 'error') throw Error('Generation failed in the QVAC backend.');
    finalState = stopped || final.stopReason === 'cancelled' ? 'cancelled' : 'completed';
    if (final.stopReason === 'length') finalMessage = `Response reached the ${settings.predict}-token limit and may be incomplete.`;
  } catch (error) {
    finalState = stopped ? 'cancelled' : 'error';
    if (!stopped) emit({ type: 'worker:error', message: errorMessage(error) });
  } finally {
    state('unloading');
    clearInterval(sampling);
    if (modelId && sdk) {
      try { await sdk.unloadModel({ modelId }); }
      catch (error) { finalState = 'error'; emit({ type: 'worker:error', message: `Unload failed: ${errorMessage(error)}` }); }
    }
    try { await sdk?.close(); } catch { /* exit releases the process */ }
    emit({ type: 'metrics', metrics: { peakRss, workerElapsedMs: performance.now() - started } });
    emit({ type: 'panel', state: finalState, message: finalMessage });
    process.disconnect?.();
  }
}

process.on('message', async message => {
  if (message?.type === 'stop') {
    stopped = true;
    if (activeRequest && sdk) await sdk.cancel({ requestId: activeRequest }).catch(() => {});
  }
  if (message?.type === 'start') execute(message);
});
