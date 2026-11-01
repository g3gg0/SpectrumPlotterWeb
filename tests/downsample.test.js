import test from 'node:test';
import assert from 'node:assert/strict';
import {Spectrometer,PIXELS,parseBuildInfo,downsampleStride,downsampleCommand,validateDownsampleAck,decodeDownsampleHeader,decodeSamples,SAMPLE_ENCODINGS} from '../protocol.js';
import {correct,DEFAULTS} from '../data.js';
const INFO={firmware:'tcd1304-advanced',protocol:1,features:['downsample-v1','sample-encoding-v1'],max_downsample:64,pixels:PIXELS,adc_bits:12};
const parsed=parseBuildInfo(new TextEncoder().encode(JSON.stringify(INFO)));
function packed(values,format){
  const bits=[16,10,12,8][format],output=new Uint8Array(Math.ceil(values.length*bits/8));let offset=0;
  for(const value of values){const code=format===1||format===3?Math.round(Math.log1p(Math.min(value,4095))/Math.log(4096)*((1<<bits)-1)):value;
    for(let bit=0;bit<bits;bit++,offset++)if(code&(1<<bit))output[offset>>3]|=1<<(offset%8);
  }return output;
}
class Port{
 constructor({badAck=false,badHeader=false}={}){
  this.writes=[];this.stride=1;this.format=0;this.frame=0;
  this.readable=new ReadableStream({start:c=>this.c=c,cancel:()=>{}});
  const send=bytes=>{for(let i=0;i<bytes.length;i+=7)this.c.enqueue(bytes.slice(i,i+7));};
  this.writable=new WritableStream({write:bytes=>{
    const cmd=new Uint8Array(bytes);this.writes.push(cmd);const view=new DataView(cmd.buffer);
    if(cmd[10]===2&&cmd[6]===255){
      if(cmd[7]!==66)return send(new TextEncoder().encode('[g3gg0.de]'));
      const json=new TextEncoder().encode(JSON.stringify(INFO)),packet=new Uint8Array(12+json.length);packet.set(new TextEncoder().encode('[g3gg0.v1]'));new DataView(packet.buffer).setUint16(10,json.length);packet.set(json,12);send(packet);
    }else if(cmd[10]===2&&cmd[6]===254){
      this.stride=view.getUint16(2);this.format=cmd[11]>>4;
      const ack=Uint8Array.of(68,83,cmd[11],badAck?1:0,0,this.stride,0,0);new DataView(ack.buffer).setUint16(6,Math.ceil(PIXELS/this.stride));send(ack);
    }else if(cmd[10]===0){
      this.frame++;const full=Array.from({length:PIXELS},(_,i)=>i===1?4095:i),samples=full.filter((_,i)=>i%this.stride===0);
      if(this.stride>1||this.format){const header=new Uint8Array(16),h=new DataView(header.buffer);header.set(new TextEncoder().encode(badHeader?'BAD!':'DSF1'));[this.stride|(this.format<<14),samples.length,0,4095,1,0].forEach((v,i)=>h.setUint16(4+i*2,v));send(header);}
      send(packed(samples,this.format));
    }
  }});
 }
 async open(){}async close(){this.closed=true;}getInfo(){return{};}
}
test('transport chooses stride from plot resolution and requires explicit capability',()=>{
 for(const [resolution,stride]of [[3694,1],[1850,2],[1024,4],[512,8],[256,15],[128,29],[64,58]])assert.equal(downsampleStride(parsed,resolution),stride);
 assert.equal(downsampleStride(null,64),1);
 assert.deepEqual([...downsampleCommand({delayUs:0x1234,triggered:true},15,3)],[69,82,0,15,18,52,254,0,68,49,2,49]);
 assert.throws(()=>downsampleStride(parsed,0));
 assert.throws(()=>parseBuildInfo(new TextEncoder().encode(JSON.stringify({...INFO,pixels:2048}))));
});
test('lossless packing and both logarithmic formats decode with bounded quantization error',()=>{
 const values=Array.from({length:4096},(_,i)=>i);
 // The wire sensor contains 3694 samples; sweep all ADC codes in two chunks.
 for(const format of [1,2,3])for(let i=0;i<4096;i+=2048){
  const input=values.slice(i,i+2048),decoded=decodeSamples(packed(input,format),input.length,format),bits=[16,10,12,8][format];
  for(let j=0;j<input.length;j++)if(format===2)assert.equal(decoded[j],input[j]);else assert.ok(Math.abs(decoded[j]-input[j])<=Math.ceil((input[j]+1)*(Math.exp(Math.log(4096)/(2*((1<<bits)-1)))-1)+0.5));
 }
 assert.throws(()=>decodeSamples(Uint8Array.of(0,128),1,1),/padding/);
 assert.throws(()=>decodeSamples(new Uint8Array(1),2,2),/length/);
});
test('sparse correction uses original pixel coordinates for wavelength and dark subtraction',()=>{
 const dark=Array.from({length:PIXELS},(_,i)=>i);
 const result=correct(Uint16Array.of(100,120,140),{...DEFAULTS,lambda:[450,.2,0,0],normalize:false,resample:64,amplitude:null},dark,15);
 assert.deepEqual(result.x,[450,453,456]);assert.deepEqual(result.y,[100,105,110]);
 const descending=correct(Uint16Array.of(100,120,140),{...DEFAULTS,lambda:[800,-.2,0,0],normalize:false,resample:64},dark,15);
 assert.deepEqual(descending.x,[794,797,800]);assert.deepEqual(descending.y,[110,105,100]);
});
test('fragmented sparse/encoded frames retain unseen clipping and calibration always returns native samples',async()=>{
 for(const encoding of SAMPLE_ENCODINGS){
  const port=new Port(),frames=[],device=new Spectrometer({onFrame:(raw,metadata)=>frames.push({raw,metadata})});await device.connect(port);
  await device.start({resample:256,encoding},{single:true});const {raw,metadata}=frames[0];
  assert.equal(raw.length,247);assert.equal(metadata.sampleStride,15);assert.equal(metadata.encoding,encoding);assert.equal(metadata.adc.status,'saturated');assert.equal(metadata.adc.clippedSamples,1);assert.equal(metadata.adc.sampleCount,PIXELS);
  // Pixel 1 is not on the transmitted grid. Health still detects its saturation.
  assert.ok(raw.every(v=>v<4095));
  const batch=[];await device.captureBatch({resample:64,encoding:'log8'},{count:1,onFrame:(r,m)=>batch.push({r,m})});
  assert.equal(batch[0].r.length,PIXELS);assert.equal(batch[0].r[1],4095);assert.equal(batch[0].m.sampleStride,1);assert.equal(batch[0].m.encoding,'raw16');
  await device.start({resample:128,encoding},{single:true});assert.equal(frames[1].raw.length,128);
  await device.disconnect();
 }
});
test('changing plot resolution and encoding takes effect at the next frame boundary',async()=>{
 const port=new Port(),frames=[];let device;
 device=new Spectrometer({onFrame:(raw,metadata)=>{frames.push(metadata);if(frames.length===1){device.setResolution(64);device.setEncoding('log8');}else device.pause();}});
 await device.connect(port);await device.start({resample:3694,encoding:'packed12'});
 assert.deepEqual(frames.map(m=>[m.sampleStride,m.encoding]),[[1,'packed12'],[58,'log8']]);await device.disconnect();
});
test('invalid acknowledgements/headers never publish a frame and disconnect safely',async()=>{
 for(const fault of ['badAck','badHeader']){
  const port=new Port({[fault]:true}),frames=[],errors=[],device=new Spectrometer({onFrame:r=>frames.push(r),onError:e=>errors.push(e)});await device.connect(port);await device.start({resample:256},{single:true});
  assert.equal(frames.length,0);assert.equal(errors.length,1);assert.equal(port.closed,true);
 }
 assert.throws(()=>validateDownsampleAck(new Uint8Array(8),2));assert.throws(()=>decodeDownsampleHeader(new Uint8Array(16),2));
});
