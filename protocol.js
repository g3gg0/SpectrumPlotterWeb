export const PIXELS = 3694;
export const FRAME_BYTES = PIXELS * 2;
export const BAUD_RATE = 500000;
export const MAGIC = '[g3gg0.de]';
export const BUILD_INFO_MAGIC = '[g3gg0.v1]';
export const MAX_BUILD_INFO_BYTES = 1024;

export function timing({shUs = 10, icgUs = 7400, delayUs = 0, averages = 1, triggered = false} = {}) {
  for (const [name, value] of Object.entries({shUs, icgUs, delayUs, averages})) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  }
  const sh = Math.round(shUs * 2);
  const icg = Math.ceil(Math.round(icgUs * 2) / sh) * sh;
  if (sh < 20 || sh > 0xffffffff) throw new Error('SH integration must be at least 10 µs and fit in 32 bits');
  if (icgUs < 7388 || icg > 0xffffffff || icg < sh) throw new Error('ICG must be at least 7388 µs, at least SH, and fit in 32 bits');
  if (!Number.isInteger(delayUs) || delayUs < 0 || delayUs > 65535) throw new Error('Trigger delay must be 0–65535 µs');
  if (!Number.isInteger(averages) || averages < 1 || averages > 15) throw new Error('Averaging must be 1–15 integrations');
  return {sh, icg, shUs:sh / 2, icgUs:icg / 2, delayUs, averages, triggered:Boolean(triggered)};
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

export function decodeFrame(bytes) {
  if (bytes.byteLength !== FRAME_BYTES) throw new Error(`Incomplete spectrum: ${bytes.byteLength}/${FRAME_BYTES} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from({length:PIXELS}, (_, i) => view.getUint16(i * 2, true));
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
    this.running = true;
    this.task = this.acquire(validated, single).finally(() => { this.task = null; });
    return this.task;
  }
  async acquire(config, single) {
    try {
      do {
        const frame = await this.readFrame(config);
        if (this.closing) break;
        this.onFrame(frame.raw, frame.metadata);
        if (single) this.running = false;
      } while (this.running && !this.closing);
      if (!this.closing) this.onState('ready');
    } catch (error) {
      if (!this.closing) { this.reportError(error); await this.disconnect(); }
    } finally { this.running = false; }
  }
  async readFrame(config) {
    this.onState(config.triggered ? 'armed' : 'acquiring', config);
    await this.writer.write(triggerCommand(config));
    // Firmware has one shared command buffer; do not overwrite it immediately.
    await new Promise(resolve => setTimeout(resolve, 3));
    await this.writer.write(captureCommand(config));
    const firstTimeout = config.triggered ? 0 : Math.max(3000, config.icgUs / 1000 * (config.averages + 8) + 1500);
    const bytes = await this.inbox.read(FRAME_BYTES, {firstTimeout, progress:this.onProgress});
    return {raw:decodeFrame(bytes), metadata:{time:new Date().toISOString(), ...config, buildInfo:this.buildInfo}};
  }
  captureBatch(settings, {count=32,signal,onFrame=()=>{},onProgress=()=>{}}={}) {
    if (!this.verified || this.closing) throw new Error('Connect a verified spectrometer first');
    if (this.task || this.running) throw new Error('Pause acquisition before starting a calibration batch');
    if (!Number.isInteger(count) || count<1 || count>1024) throw new Error('Invalid calibration frame count');
    if (signal?.aborted) throw new DOMException('Cancelled','AbortError');
    const config=timing({...settings,triggered:false,averages:1});
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
