import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSummary,buildDate,deviceInfoRows} from '../device-info.js';

test('verified summary includes version, commit and modified state',()=>{
  assert.equal(buildSummary({version:'1.1.0',commit:'9376e02812345678',dirty:true}),'v1.1.0 · 9376e028 · modified');
  assert.match(buildSummary(null),/Legacy firmware/);
  assert.equal(buildDate({built_at:'2026-11-01T12:34:56Z'}),'2026-11-01 12:34:56 UTC');
  assert.match(buildDate({built_at:'Nov  1 2026 12:34:56',build_timezone:'unspecified'}),/unspecified/);
});
test('device details retain full commit and do not invent missing provenance',()=>{
  const info={version:'1.1.0',commit:'9376e02864f1fc524f94398520c686b4e46f92af',dirty:false,branch:'HEAD',cpu_hz:84000000};
  const rows=Object.fromEntries(deviceInfoRows(info,{usbVendorId:0x0483,usbProductId:0x374b}));
  assert.equal(rows.Commit,info.commit);assert.equal(rows['Working tree'],'Clean');assert.equal(rows.Branch,'Detached HEAD');assert.equal(rows['USB vendor / product'],'0x0483 / 0x374b');
  const legacy=Object.fromEntries(deviceInfoRows(null));assert.equal(legacy.Built,'Not available');assert.equal(legacy.Commit,'Not available');assert.equal(legacy['Working tree'],'Unknown');
});
