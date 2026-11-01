import test from 'node:test';
import assert from 'node:assert/strict';
import {ByteInbox,Spectrometer,timing,probeCommand,buildInfoCommand,parseBuildInfo,BUILD_INFO_MAGIC,triggerCommand,captureCommand,decodeFrame,PIXELS,FRAME_BYTES} from '../protocol.js';

test('commands preserve endian order and align physical timing to the 2 MHz clock',()=>{
  const config=timing({shUs:10,icgUs:7388,delayUs:0x1234,triggered:true,averages:15});
  assert.equal(config.sh,20);assert.equal(config.icg,14780);
  assert.deepEqual([...triggerCommand(config)],[69,82,0,0,0x12,0x34,0,0,0,0,2,0]);
  assert.deepEqual([...captureCommand(config)],[69,82,0,0,0,20,0,0,0x39,0xbc,0,15]);
  assert.equal(probeCommand()[6],255);
  assert.deepEqual([...buildInfoCommand()],[69,82,0,0,0,0,255,66,73,49,2,1]);
  assert.throws(()=>timing({delayUs:65536}));assert.throws(()=>timing({shUs:5}));
  assert.throws(()=>timing({icgUs:100}));assert.throws(()=>timing({averages:16}));
});
test('samples decode as little endian and incomplete frames are rejected',()=>{
  const bytes=new Uint8Array(FRAME_BYTES);bytes.set([0x34,0x12,0xff,0x0f]);
  assert.deepEqual([...decodeFrame(bytes).slice(0,2)],[0x1234,0x0fff]);
  assert.throws(()=>decodeFrame(bytes.subarray(0,-1)),/Incomplete/);
});
test('exact reads consume arbitrary fragments and retain bytes for the next read',async()=>{
  const inbox=new ByteInbox();const first=inbox.read(5);
  inbox.push(Uint8Array.of(1,2));inbox.push(Uint8Array.of(3));inbox.push(Uint8Array.of(4,5,6,7));
  assert.deepEqual([...await first],[1,2,3,4,5]);
  assert.deepEqual([...await inbox.read(2)],[6,7]);
});
test('trigger wait allows no first-byte deadline but partial frames time out',async()=>{
  const inbox=new ByteInbox();const wait=inbox.read(10,{firstTimeout:0,gapTimeout:20});
  await new Promise(resolve=>setTimeout(resolve,25));assert.ok(inbox.pending);
  const rejection=assert.rejects(wait,/1\/10/);inbox.push(Uint8Array.of(42));await rejection;
  await assert.rejects(inbox.read(1),/alignment/);
});
test('disconnect rejects a pending trigger read instead of hanging',async()=>{
  const inbox=new ByteInbox();const controller=new AbortController();
  const waiting=inbox.read(FRAME_BYTES,{firstTimeout:0,signal:controller.signal});
  const rejected=assert.rejects(waiting,{name:'AbortError'});controller.abort();await rejected;
});

const BUILD_INFO={firmware:'tcd1304-advanced',protocol:1,version:'1.1.0',built_at:'2026-11-01T12:34:56Z',build_timezone:'UTC',commit:'9376e02864f1fc524f94398520c686b4e46f92af',dirty:true,branch:'master',board:'nucleo_f401re',mcu:'stm32f401ret6',compiler:'7.2.1',cpu_hz:84000000,ccd_clock_hz:2000000};
function infoPacket(info){
  const payload=new TextEncoder().encode(JSON.stringify(info));const packet=new Uint8Array(12+payload.length);
  packet.set(new TextEncoder().encode(BUILD_INFO_MAGIC));new DataView(packet.buffer).setUint16(10,payload.length,false);packet.set(payload,12);return packet;
}
class MockPort {
  constructor({identity='[g3gg0.de]',deliver=true,truncate=false,buildInfo=null,rawInfo=null}={}){
    this.writes=[];this.opened=false;this.closed=false;this.deliver=deliver;
    this.readable=new ReadableStream({start:controller=>this.controller=controller,cancel:()=>{this.cancelled=true;}});
    this.writable=new WritableStream({write:async bytes=>{
      const command=new Uint8Array(bytes);this.writes.push(command);
      if(command[10]===2&&command[6]===255){
        const isInfo=command[7]===66&&command[8]===73&&command[9]===49&&command[11]===1;
        const data=isInfo&&(rawInfo||buildInfo)?rawInfo||infoPacket(buildInfo):new TextEncoder().encode(identity);
        for(let offset=0;offset<data.length;offset+=7)this.controller.enqueue(data.slice(offset,offset+7));
      }
      if(command[10]===0&&deliver){
        const data=new Uint8Array(FRAME_BYTES);const view=new DataView(data.buffer);
        for(let i=0;i<PIXELS;i++)view.setUint16(i*2,i,true);
        if(truncate){this.controller.enqueue(data.slice(0,25));this.controller.close();}
        else for(let i=0;i<data.length;i+=113)this.controller.enqueue(data.slice(i,i+113));
      }
    }});
  }
  async open(options){this.opened=true;this.options=options;}
  getInfo(){return {usbVendorId:0x0483,usbProductId:0x374b};}
  async close(){assert.equal(this.readable.locked,false);assert.equal(this.writable.locked,false);this.closed=true;}
}
test('verified device delivers complete spectra through fragmented Web Serial streams',async()=>{
  const port=new MockPort();const frames=[],states=[];
  const device=new Spectrometer({onFrame:(raw,metadata)=>frames.push({raw,metadata}),onState:state=>states.push(state)});
  await device.connect(port);assert.equal(device.verified,true);assert.equal(port.options.baudRate,500000);
  await device.start({shUs:10,icgUs:7400},{single:true});
  assert.equal(frames.length,1);assert.equal(frames[0].raw.length,3694);assert.equal(frames[0].raw.at(-1),3693);
  assert.deepEqual(port.writes.map(c=>c[10]),[2,2,2,0]);assert.ok(states.includes('ready'));assert.equal(device.buildInfo,null);
  await device.disconnect();assert.equal(port.closed,true);assert.equal(device.verified,false);
});
test('unknown device is closed without sending capture commands',async()=>{
  const port=new MockPort({identity:'not-a-CCD!'}),device=new Spectrometer();
  await assert.rejects(device.connect(port),/Unknown device/);
  assert.equal(port.writes.length,1);assert.equal(port.closed,true);
});
test('an armed acquisition is cancellable and releases both stream locks',async()=>{
  const port=new MockPort({deliver:false});const device=new Spectrometer();await device.connect(port);
  const task=device.start({triggered:true});await new Promise(resolve=>setTimeout(resolve,10));
  await device.disconnect();await task;assert.equal(port.closed,true);assert.equal(device.running,false);
});
test('unplugging midway through a frame never publishes partial data',async()=>{
  const port=new MockPort({truncate:true}),frames=[],errors=[];
  const device=new Spectrometer({onFrame:frame=>frames.push(frame),onError:error=>errors.push(error)});
  await device.connect(port);await device.start({}, {single:true});await device.disconnect();
  assert.equal(frames.length,0);assert.equal(errors.length,1);assert.equal(port.closed,true);
});

test('extended identity reads fragmented metadata without contaminating the first spectrum',async()=>{
  const port=new MockPort({buildInfo:BUILD_INFO}),frames=[],ready=[];
  const device=new Spectrometer({onState:(state,details)=>{if(state==='ready'&&details)ready.push(details);},onFrame:(raw,metadata)=>frames.push({raw,metadata})});
  await device.connect(port);assert.equal(device.verified,true);assert.equal(device.buildInfo.commit,BUILD_INFO.commit);
  assert.equal(ready[0].buildInfo.built_at,BUILD_INFO.built_at);assert.equal(ready[0].usbVendorId,0x0483);
  await device.start({}, {single:true});assert.equal(frames[0].raw[0],0);assert.equal(frames[0].raw.at(-1),3693);
  assert.equal(frames[0].metadata.buildInfo.dirty,true);
  await device.disconnect();assert.equal(device.buildInfo,null);
  await device.connect(new MockPort());assert.equal(device.buildInfo,null);assert.equal(ready.at(-1).buildInfo,null);
  await device.disconnect();
});
test('invalid metadata framing closes the device before any capture is sent',async()=>{
  for(const length of [0,1025]){
    const header=new Uint8Array(12);header.set(new TextEncoder().encode(BUILD_INFO_MAGIC));new DataView(header.buffer).setUint16(10,length,false);
    const port=new MockPort({rawInfo:header}),device=new Spectrometer();
    await assert.rejects(device.connect(port),/length/);assert.equal(port.closed,true);assert.equal(port.writes.length,2);assert.equal(device.verified,false);
  }
});
test('invalid JSON/schema cannot silently verify as extended firmware',async()=>{
  for(const info of [{...BUILD_INFO,protocol:2},{...BUILD_INFO,commit:'not-a-commit'},{...BUILD_INFO,dirty:'yes'}]){
    const port=new MockPort({buildInfo:info}),device=new Spectrometer();
    await assert.rejects(device.connect(port));assert.equal(port.closed,true);assert.equal(device.buildInfo,null);
  }
  assert.throws(()=>parseBuildInfo(new TextEncoder().encode('{broken')));
  assert.throws(()=>parseBuildInfo(Uint8Array.of(0xff)));
});

test('calibration batches exclusively collect fresh untriggered single integrations',async()=>{
  const port=new MockPort(),normal=[],batch=[],progress=[];
  const device=new Spectrometer({onFrame:raw=>normal.push(raw)});await device.connect(port);
  const result=await device.captureBatch({triggered:true,averages:15},{count:3,onFrame:(raw,metadata)=>batch.push({raw,metadata}),onProgress:(done,total)=>progress.push([done,total])});
  assert.equal(normal.length,0);assert.equal(batch.length,3);assert.equal(result.config.triggered,false);assert.equal(result.config.averages,1);
  assert.deepEqual(progress,[[0,3],[1,3],[2,3],[3,3]]);
  assert.ok(port.writes.filter(c=>c[10]===0).every(c=>c[11]===1));
  assert.ok(batch.every(f=>f.raw.length===PIXELS&&f.metadata.triggered===false));
  await device.disconnect();
});
test('rejecting a fully received calibration frame preserves the serial connection',async()=>{
  const device=new Spectrometer(),port=new MockPort();await device.connect(port);
  await assert.rejects(device.captureBatch({}, {count:2,onFrame:()=>{throw new Error('Saturated reference');}}),/Saturated/);
  assert.equal(device.verified,true);assert.equal(device.task,null);
  let received=0;await device.captureBatch({}, {count:1,onFrame:()=>received++});assert.equal(received,1);
  await device.disconnect();
});
test('aborting a pending calibration frame closes the port and rejects the batch',async()=>{
  const device=new Spectrometer(),port=new MockPort({deliver:false});await device.connect(port);
  const controller=new AbortController();const task=device.captureBatch({}, {count:16,signal:controller.signal});
  const rejected=assert.rejects(task,{name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.throws(()=>device.captureBatch({}, {count:1}),/Pause acquisition/);
  controller.abort();await rejected;assert.equal(port.closed,true);assert.equal(device.task,null);
});
