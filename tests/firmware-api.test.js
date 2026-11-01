import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {firmwareRequest} from '../firmware-api.mjs';

const commit='a'.repeat(40);
const binary=Buffer.alloc(16);binary.writeUInt32LE(0x20018000,0);binary.writeUInt32LE(0x08000101,4);
function fixture(overrides={}){
  const manifest={board:'nucleo_f401re',commit,filename:'tcd1304-advanced.bin',size:binary.length,sha256:createHash('sha256').update(binary).digest('hex'),...overrides};
  const json=Buffer.from(JSON.stringify(manifest));
  const release={id:1,tag_name:`build-${commit}`,name:'Firmware test',published_at:'2026-11-01',assets:[{id:2,name:'manifest.json',size:json.length},{id:3,name:'tcd1304-advanced.bin',size:binary.length}]};
  const fetcher=async url=>{
    if(url.includes('/assets/2'))return new Response(json);
    if(url.includes('/assets/3'))return new Response(binary);
    if(url.includes('/releases?'))return Response.json([release,{...release,tag_name:'v1.0'}]);
    return Response.json(release);
  };
  return fetcher;
}
test('lists only downloadable commit builds',async()=>{
  const result=await firmwareRequest(new URL('http://localhost/api/firmware/releases'),fixture());
  const data=JSON.parse(result.body);assert.equal(data.builds.length,1);assert.equal(data.builds[0].commit,commit);assert.equal(data.nextPage,null);
});
test('downloads and verifies the exact binary',async()=>{
  const result=await firmwareRequest(new URL('http://localhost/api/firmware/releases/1/binary'),fixture());
  assert.equal(result.type,'application/octet-stream');assert.deepEqual(result.body,binary);
});
test('rejects wrong board, commit and checksum',async()=>{
  for(const override of [{board:'nucleo_f411re'},{commit:'b'.repeat(40)},{sha256:'0'.repeat(64)}]){
    await assert.rejects(firmwareRequest(new URL('http://localhost/api/firmware/releases/1/binary'),fixture(override)));
  }
});
test('reports GitHub failures and rejects invalid routes/pages',async()=>{
  await assert.rejects(firmwareRequest(new URL('http://localhost/api/firmware/releases'),async()=>new Response('',{status:403})),/GitHub request failed/);
  await assert.rejects(firmwareRequest(new URL('http://localhost/api/firmware/releases?page=-1'),fixture()),/Invalid release page/);
  assert.equal(await firmwareRequest(new URL('http://localhost/api/firmware/releases/invalid/binary'),fixture()),null);
});
