import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {listFirmwareBuilds,loadFirmwareBinary} from '../firmware.js';

const commit='a'.repeat(40);
const binary=Buffer.alloc(16);binary.writeUInt32LE(0x20018000,0);binary.writeUInt32LE(0x08000101,4);
async function fixture(run,overrides={}){
  const previous=globalThis.fetch;
  const manifest={board:'nucleo_f401re',commit,filename:'tcd1304-advanced.bin',size:binary.length,sha256:createHash('sha256').update(binary).digest('hex'),...overrides};
  globalThis.fetch=async url=>{
    assert.equal(new URL(url).origin,'https://g3gg0.github.io');
    if(String(url).endsWith('manifest.json'))return Response.json(manifest);
    if(String(url).endsWith('firmware.bin'))return new Response(binary);
    return Response.json({builds:[{commit,name:'Commit title',date:'2026-11-01'}]});
  };
  try{await run();}finally{globalThis.fetch=previous;}
}
test('browser loads catalog and verifies firmware size, checksum and board',async()=>{
  await fixture(async()=>{
    assert.equal((await listFirmwareBuilds())[0].commit,commit);
    assert.deepEqual(new Uint8Array(await loadFirmwareBinary(commit)),new Uint8Array(binary));
  });
});
test('rejects invalid commit, board, checksum and expected size',async()=>{
  await assert.rejects(loadFirmwareBinary('../invalid'),/Invalid firmware commit/);
  for(const override of [{board:'nucleo_f411re'},{commit:'b'.repeat(40)},{sha256:'0'.repeat(64)},{size:32},{size:8}]){
    await fixture(async()=>{await assert.rejects(loadFirmwareBinary(commit));},override);
  }
});
test('archive HTTP and CORS failures are visible',async()=>{
  const previous=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response('',{status:404});
    await assert.rejects(listFirmwareBuilds(),/Enable GitHub Pages/);
    globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
    await assert.rejects(listFirmwareBuilds(),/Cannot reach.*GitHub Pages/);
  }finally{globalThis.fetch=previous;}
});
