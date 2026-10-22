import test from 'node:test';
import assert from 'node:assert/strict';
import { runPanels } from './sequential.mjs';

test('B starts only after A process exits', async () => {
  const events = [];
  let exitA;
  const first = new Promise(resolve => { exitA = resolve; });
  const task = runPanels({ paths:['a','b'], cancelled:()=>false, state:s=>events.push(s), error:()=>{},
    start:async panel=>{events.push(`start${panel}`);if(panel==='A')await first;events.push(`exit${panel}`)} });
  await Promise.resolve();
  assert.deepEqual(events,['runningA','startA']);
  exitA();
  assert.equal(await task,'completed');
  assert.ok(events.indexOf('exitA') < events.indexOf('startB'));
});

test('A error still permits B after A exits', async () => {
  const events=[];
  const result=await runPanels({paths:['a','b'],cancelled:()=>false,state:s=>events.push(s),error:p=>events.push(`error${p}`),
    start:async p=>{events.push(`start${p}`);if(p==='A')throw Error('failed');events.push(`exit${p}`)}});
  assert.equal(result,'completed');
  assert.ok(events.indexOf('errorA')<events.indexOf('startB'));
});

test('stop suppresses queued B', async () => {
  let stopped=false;
  const starts=[];
  const result=await runPanels({paths:['a','b'],cancelled:()=>stopped,state:()=>{},error:()=>{},
    start:async p=>{starts.push(p);stopped=true}});
  assert.equal(result,'cancelled');
  assert.deepEqual(starts,['A']);
});
