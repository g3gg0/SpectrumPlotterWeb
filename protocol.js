import {readAdcStatistics} from './adc.js';
export const PIXELS = 3694;
export const FRAME_BYTES = PIXELS * 2;
export const BAUD_RATE = 500000;
export const MAGIC = '[g3gg0.de]';
export const BUILD_INFO_MAGIC = '[g3gg0.v1]';
export const MAX_BUILD_INFO_BYTES = 1024;

export function timing({shUs = 10, icgUs = 7400, delayUs = 0, averages = 1, triggered = false, resample = PIXELS, encoding = 'packed12'} = {}) {
  for (const [name, value] of Object.entries({shUs, icgUs, delayUs, averages})) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  }
  const sh = Math.round(shUs * 2);
  const icg = Math.ceil(Math.round(icgUs * 2) / sh) * sh;
  if (sh < 20 || sh > 0xffffffff) throw new Error('SH integration must be at least 10 µs and fit in 32 bits');
  if (icgUs < 7388 || icg > 0xffffffff || icg < sh) throw new Error('ICG must be at least 7388 µs, at least SH, and fit in 32 bits');
  if (!Number.isInteger(delayUs) || delayUs < 0 || delayUs > 65535) throw new Error('Trigger delay must be 0–65535 µs');
  if (!Number.isInteger(averages) || averages < 1 || averages > 15) throw new Error('Averaging must be 1–15 integrations');
  if (!Number.isInteger(resample) || resample < 64 || resample > PIXELS) throw new Error('Invalid plot resolution');
  if (!['raw16','packed12','log10','log8'].includes(encoding)) throw new Error('Invalid sample encoding');
  return {encoding, resample, sh, icg, shUs:sh / 2, icgUs:icg / 2, delayUs, averages, triggered:Boolean(triggered)};
}

export function probeCommand() {
  return Uint8Array.of(0x45,0x52,0,0,0,0,0xff,0,1,0,2,0);
}

export function buildInfoCommand() {
  // Legacy firmware safely answers this as an ordinary identity probe.
  return Uint8Array.of(0x45,0x52,0,0,0,0,0xff,0x42,0x49,0x31,2,1);
}

export function parseBuildInfo(bytes) {
  const object = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (!object || Array.isArray(object) || object.firmware !== 'tcd1304-advanced' || object.protocol !== 1)
    throw new Error('Unsupported firmware build-information protocol');
  const info = {firmware:object.firmware, protocol:object.protocol};
  for (const key of ['version','built_at','build_timezone','commit','describe','branch','board','mcu','environment','compiler']) {
    const value = object[key] ?? null;
    if (value !== null && (typeof value !== 'string' || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)))
      throw new Error(`Invalid firmware build-information field: ${key}`);
    info[key] = value;
  }
  if (info.commit !== null && !/^[0-9a-f]{7,64}$/i.test(info.commit)) throw new Error('Invalid firmware Git commit');
  if (object.dirty !== undefined && object.dirty !== null && typeof object.dirty !== 'boolean') throw new Error('Invalid firmware working-tree state');
  info.dirty = object.dirty ?? null;
  for (const key of ['cpu_hz','ccd_clock_hz']) {
    const value = object[key] ?? null;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)) throw new Error(`Invalid firmware clock: ${key}`);
    info[key] = value;
  }
  info.features = object.features ?? [];
  if (!Array.isArray(info.features) || info.features.length > 32 || info.features.some(f=>typeof f !== 'string' || !/^[a-z0-9-]{1,48}$/.test(f))) throw new Error('Invalid firmware features');
  for (const key of ['max_downsample','pixels','adc_bits']) {
    info[key] = object[key] ?? null;
    if (info[key] !== null && (!Number.isSafeInteger(info[key]) || info[key] < 1 || info[key] > 65535)) throw new Error(`Invalid firmware capability: ${key}`);
  }
  if (info.features.includes('downsample-v1') && (info.max_downsample > 64 || !info.max_downsample || info.pixels !== PIXELS || info.adc_bits !== 12)) throw new Error('Unsupported downsample geometry');
  if (info.features.includes('sample-encoding-v1') && !info.features.includes('downsample-v1')) throw new Error('Sample encoding requires downsample framing');
  if (info.features.includes('fast-acquisition-v1') && !info.features.includes('downsample-v1')) throw new Error('Fast acquisition requires downsample configuration');
  return info;
}

export function triggerCommand(config) {
  const command = new Uint8Array(12);
  command.set([0x45,0x52]);
  new DataView(command.buffer).setUint16(4, config.delayUs, false);
  command[6] = config.triggered ? 0 : 2;
  command[10] = 2;
  return command;
}

export function downsampleStride(info, resolution = PIXELS) {
  if (!Number.isInteger(resolution) || resolution < 64 || resolution > PIXELS) throw new Error('Invalid plot resolution');
  return info?.features?.includes('downsample-v1') ? Math.min(info.max_downsample, Math.ceil(PIXELS / resolution)) : 1;
}

export function downsampleCommand(config, stride, encoding = 0, fast = false) {
  if (!Number.isInteger(stride) || stride < 1 || stride > 64) throw new Error('Invalid sample stride');
  if (!Number.isInteger(encoding) || encoding<0 || encoding>3) throw new Error('Invalid sample encoding');
  const command = Uint8Array.of(69,82,0,0,0,0,254,config.triggered?0:2,68,49,2,1|(encoding<<4)|(fast?0x40:0));
  const view = new DataView(command.buffer);
  view.setUint16(2,stride,false);view.setUint16(4,config.delayUs,false);
  return command;
}

export function validateDownsampleAck(bytes, stride, encoding = 0, fast = false) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (bytes.length !== 8 || bytes[0] !== 68 || bytes[1] !== 83 || bytes[2] !== (1|(encoding<<4)|(fast?0x40:0)) || bytes[3] !== 0 || view.getUint16(4) !== stride || view.getUint16(6) !== Math.ceil(PIXELS/stride)) throw new Error('Invalid downsample acknowledgement');
}

export function decodeDownsampleHeader(bytes, stride, encoding = 0) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (bytes.length !== 16 || new TextDecoder().decode(bytes.subarray(0,4)) !== 'DSF1' || view.getUint16(4) !== (stride|(encoding<<14)) || view.getUint16(6) !== Math.ceil(PIXELS/stride)) throw new Error('Invalid downsample frame header');
  const adc = readAdcStatistics({version:1,bits:12,fullScale:4095,sampleCount:PIXELS,minimum:view.getUint16(8),peak:view.getUint16(10),clippedSamples:view.getUint16(12),invalidSamples:view.getUint16(14)});
  if (!adc || adc.minimum > adc.peak || adc.peak > 65535 || (adc.invalidSamples > 0) !== (adc.peak > 4095)) throw new Error('Invalid downsample ADC statistics');
  return adc;
}

export function captureCommand(config) {
  const command = new Uint8Array(12);
  command.set([0x45,0x52]);
  const view = new DataView(command.buffer);
  view.setUint32(2, config.sh, false);
  view.setUint32(6, config.icg, false);
  command[10] = 0; // Always one shot; repeat on the host after each complete frame.
  command[11] = config.averages;
  return command;
}

export const SAMPLE_ENCODINGS = ['raw16','log10','packed12','log8'];
export const encodingBits = encoding => [16,10,12,8][encoding];
export function decodeSamples(bytes,count,encoding=0) {
  if (encoding===0) return decodeFrame(bytes,count);
  const bits=encodingBits(encoding);
  if (!Number.isInteger(count) || count<1 || count>PIXELS || !bits || bytes.length!==Math.ceil(count*bits/8)) throw new Error('Invalid packed spectrum length');
  const raw=new Uint16Array(count),mask=(1<<bits)-1;
  let accumulator=0,used=0,offset=0;
  for(let i=0;i<count;i++) {
    while(used<bits){accumulator|=bytes[offset++]<<used;used+=8;}
    const code=accumulator&mask;accumulator>>>=bits;used-=bits;
    raw[i]=encoding===2?code:Math.round(Math.expm1(code/mask*Math.log(4096)));
  }
  if(accumulator!==0)throw new Error('Invalid packed spectrum padding');
  return raw;
}

export function decodeFrame(bytes, count = PIXELS) {
  if (!Number.isInteger(count) || count < 1 || count > PIXELS || bytes.byteLength !== count*2) throw new Error(`Incomplete spectrum: ${bytes.byteLength}/${count*2} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from({length:count}, (_, i) => view.getUint16(i * 2, true));
}

// One receiver owns the serial reader. Exact reads consume fragments and retain surplus bytes.
export class ByteInbox {
  constructor() { this.chunks = []; this.available = 0; this.pending = null; this.error = null; }
  clear() { this.chunks = []; this.available = 0; }
  push(chunk) {
    if (this.error) return;
    this.chunks.push(chunk); this.available += chunk.length;
    if (this.available > FRAME_BYTES * 4) { this.fail(new Error('Unframed serial data exceeded the receive limit')); return; }
    this.drain();
  }
  drain() {
    const p = this.pending;
    if (!p) return;
    while (this.chunks.length && p.offset < p.bytes.length) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, p.bytes.length - p.offset);
      p.bytes.set(chunk.subarray(0, take), p.offset);
      p.offset += take; this.available -= take;
      if (take === chunk.length) this.chunks.shift(); else this.chunks[0] = chunk.subarray(take);
    }
    p.progress?.(p.offset, p.bytes.length);
    clearTimeout(p.timer);
    if (p.offset === p.bytes.length) {
      this.pending = null; p.signal?.removeEventListener('abort', p.abort); p.resolve(p.bytes);
    } else {
      const wait = p.offset ? p.gapTimeout : p.firstTimeout;
      if (wait > 0) p.timer = setTimeout(() => this.fail(new Error(`Serial timeout: ${p.offset}/${p.bytes.length} bytes. Reconnect to restore frame alignment.`)), wait);
    }
  }
  read(length, {firstTimeout = 2000, gapTimeout = 2000, signal, progress} = {}) {
    if (this.error) return Promise.reject(this.error);
    if (this.pending) return Promise.reject(new Error('A serial read is already pending'));
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      const p = {bytes:new Uint8Array(length), offset:0, firstTimeout, gapTimeout, resolve, reject, progress, signal};
      p.abort = () => this.fail(new DOMException('Cancelled', 'AbortError'));
      signal?.addEventListener('abort', p.abort, {once:true});
      this.pending = p;
      this.drain();
    });
  }
  fail(error) {
    this.error = error;
    const p = this.pending; this.pending = null;
    if (p) { clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort); p.reject(error); }
  }
}

export class Spectrometer {
  constructor({onState = () => {}, onFrame = () => {}, onError = () => {}, onProgress = () => {}} = {}) {
    Object.assign(this, {onState, onFrame, onError, onProgress});
    this.port = null; this.verified = false; this.running = false; this.closing = false; this.buildInfo = null;
  }
  async connect(port) {
    if (this.port) throw new Error('Disconnect the existing device first');
    this.closing = false; this.failed = false; this.buildInfo = null; this.inbox = new ByteInbox(); this.port = port;
    this.onState('connecting');
    try {
      await port.open({baudRate:BAUD_RATE, dataBits:8, stopBits:1, parity:'none', flowControl:'none', bufferSize:32768});
      this.reader = port.readable.getReader(); this.writer = port.writable.getWriter();
      this.pump = this.receive();
      // Drain stale data before a fixed-size identity exchange.
      await new Promise(resolve => setTimeout(resolve, 250));
      this.inbox.clear();
      await this.writer.write(probeCommand());
      const response = await this.inbox.read(10, {firstTimeout:1600});
      if (new TextDecoder().decode(response) !== MAGIC) throw new Error('Unknown device: expected the tcd1304-advanced identity [g3gg0.de]');
      await new Promise(resolve => setTimeout(resolve, 3));
      await this.writer.write(buildInfoCommand());
      const signature = new TextDecoder().decode(await this.inbox.read(10, {firstTimeout:1600}));
      if (signature === BUILD_INFO_MAGIC) {
        const lengthBytes = await this.inbox.read(2);
        const length = (lengthBytes[0] << 8) | lengthBytes[1];
        if (length === 0 || length > MAX_BUILD_INFO_BYTES) throw new Error(`Invalid firmware build-information length: ${length}`);
        this.buildInfo = parseBuildInfo(await this.inbox.read(length));
      } else if (signature !== MAGIC) {
        throw new Error('Unrecognized firmware build-information response');
      }
      this.verified = true;
      this.onState('ready', {...(port.getInfo?.() || {}), buildInfo:this.buildInfo});
    } catch (error) { await this.disconnect(); throw error; }
  }
  async receive() {
    try {
      while (!this.closing) {
        const {value, done} = await this.reader.read();
        if (done) {
          if (!this.closing) throw new Error('Serial device disconnected');
          break;
        }
        if (value?.length) this.inbox.push(value);
      }
    } catch (error) {
      this.inbox.fail(error);
      if (!this.closing) {
        this.reportError(error);
        // Leave the reader loop before closing its stream.
        queueMicrotask(() => this.disconnect());
      }
    } finally { this.reader?.releaseLock(); this.reader = null; }
  }
  start(config, {single = false} = {}) {
    if (!this.verified || this.closing) throw new Error('Connect a verified spectrometer first');
    if (this.running || this.task) return;
    const validated = timing(config);
    this.targetResolution = validated.resample;
    this.targetEncoding = validated.encoding;
    this.running = true;
    this.task = this.acquire(validated, single).finally(() => { this.task = null; });
    return this.task;
  }
  async acquire(config, single) {
    try {
      do {
        const frame = await this.readFrame(config, {resolution:this.targetResolution,encoding:this.targetEncoding,fast:true});
        if (this.closing) break;
        this.onFrame(frame.raw, frame.metadata);
        if (single) this.running = false;
      } while (this.running && !this.closing);
      if (!this.closing) this.onState('ready');
    } catch (error) {
      if (!this.closing) { this.reportError(error); await this.disconnect(); }
    } finally { this.running = false; }
  }
  setResolution(resolution) {
    downsampleStride(this.buildInfo,resolution);this.targetResolution=resolution;
  }
  setEncoding(encoding) {
    if (!SAMPLE_ENCODINGS.includes(encoding)) throw new Error('Invalid sample encoding');
    this.targetEncoding=encoding;
  }
  async readFrame(config, {resolution=PIXELS,encoding='raw16',fast=false}={}) {
    const started=performance.now();let firstByte=null;
    const markFirstByte=received=>{if(received>0&&firstByte===null)firstByte=performance.now();};
    const stride=downsampleStride(this.buildInfo,resolution), count=Math.ceil(PIXELS/stride);
    const format=this.buildInfo?.features.includes('sample-encoding-v1')?SAMPLE_ENCODINGS.indexOf(encoding):0;
    const fastAcquisition=Boolean(fast&&!config.triggered&&this.buildInfo?.features.includes('fast-acquisition-v1'));
    const framed=stride>1||format>0,payloadBytes=Math.ceil(count*encodingBits(format)/8);
    this.onState(config.triggered ? 'armed' : 'acquiring', config);
    if (this.buildInfo?.features.includes('downsample-v1')) {
      await this.writer.write(downsampleCommand(config,stride,format,fastAcquisition));
      validateDownsampleAck(await this.inbox.read(8),stride,format,fastAcquisition);
    } else {
      await this.writer.write(triggerCommand(config));
      // Legacy firmware has one shared command buffer.
      await new Promise(resolve=>setTimeout(resolve,3));
    }
    await this.writer.write(captureCommand(config));
    const captureSent=performance.now();
    const firstTimeout=config.triggered?0:Math.max(3000,config.icgUs/1000*(config.averages+8)+1500);
    const adc=framed?decodeDownsampleHeader(await this.inbox.read(16,{firstTimeout,progress:markFirstByte}),stride,format):undefined;
    const bytes=await this.inbox.read(payloadBytes,{firstTimeout:framed?2000:firstTimeout,progress:(received,total)=>{markFirstByte(received);this.onProgress(received,total);}});
    const completed=performance.now(),timings={configureMs:captureSent-started,waitForDataMs:Math.max(0,firstByte-captureSent),receiveMs:completed-firstByte,totalMs:completed-started};
    return {raw:decodeSamples(bytes,count,format),metadata:{time:new Date().toISOString(),...config,timings,buildInfo:this.buildInfo,sampleStride:stride,fullPixels:PIXELS,transmittedSamples:count,encoding:SAMPLE_ENCODINGS[format],fastAcquisition,wireBytes:payloadBytes+(framed?16:0),...(adc?{adc}:{})}};
  }
  captureBatch(settings, {count=32,signal,onFrame=()=>{},onProgress=()=>{}}={}) {
    if (!this.verified || this.closing) throw new Error('Connect a verified spectrometer first');
    if (this.task || this.running) throw new Error('Pause acquisition before starting a calibration batch');
    if (!Number.isInteger(count) || count<1 || count>1024) throw new Error('Invalid calibration frame count');
    if (signal?.aborted) throw new DOMException('Cancelled','AbortError');
    const config=timing({...settings,triggered:false,averages:1,resample:PIXELS});
    const cancel=()=>{this.disconnect();};
    signal?.addEventListener('abort',cancel,{once:true});
    this.running=true;
    this.task=(async()=>{
      try {
        onProgress(0,count);
        for (let i=0;i<count;i++) {
          if (signal?.aborted || !this.running || this.closing) throw new DOMException('Cancelled','AbortError');
          let frame;
          try { frame=await this.readFrame(config); }
          catch (error) { await this.disconnect();throw error; }
          if (signal?.aborted || this.closing) throw new DOMException('Cancelled','AbortError');
          // Consumer validation runs after a full frame, so rejecting a saturated
          // reference does not corrupt stream alignment or require a disconnect.
          onFrame(frame.raw,frame.metadata);
          onProgress(i+1,count);
        }
        return {count,config};
      } finally {
        signal?.removeEventListener('abort',cancel);
        this.running=false;
        if (this.verified&&!this.closing) this.onState('ready');
      }
    })().finally(()=>{this.task=null;});
    return this.task;
  }
  pause() { this.running = false; this.onState('finishing'); }
  reportError(error) { if (!this.failed) { this.failed = true; this.onError(error); } }
  async disconnect() {
    if (this.closeTask) return this.closeTask;
    this.closeTask = this.closePort().finally(() => { this.closeTask = null; });
    return this.closeTask;
  }
  async closePort() {
    this.closing = true; this.running = false; this.verified = false; this.buildInfo = null;
    this.inbox?.fail(new DOMException('Disconnected', 'AbortError'));
    try { await this.reader?.cancel(); } catch { /* Device may have been unplugged. */ }
    await this.pump;
    this.writer?.releaseLock(); this.writer = null;
    try { await this.port?.close(); } catch { /* Port may already be closed. */ }
    this.port = null;
    this.onState('disconnected');
  }
}
