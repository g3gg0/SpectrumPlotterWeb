export function buildSummary(info) {
  if (!info) return 'Legacy firmware · no build metadata';
  const version=info.version?`v${info.version}`:'Version unknown';
  const commit=info.commit?info.commit.slice(0,8):'Git unavailable';
  return `${version} · ${commit}${info.dirty===true?' · modified':''}`;
}

export function buildDate(info) {
  if (!info?.built_at) return 'Not available';
  const date=info.built_at;
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(date)) return date.replace('T',' ').replace('Z',' UTC');
  return `${date} (${info.build_timezone||'timezone unspecified'})`;
}

export function deviceInfoRows(info, usb={}) {
  const usbId=value=>Number.isInteger(value)?`0x${value.toString(16).padStart(4,'0')}`:'Not available';
  const clock=value=>value?`${value.toLocaleString('en-US')} Hz`:'Not available';
  return [
    ['Firmware', info?.firmware||'tcd1304-advanced'],
    ['Version', info?.version||'Not reported by legacy firmware'],
    ['Protocol', info?`Build information v${info.protocol}`:'Legacy identity only'],
    ['Downsample', info?.features?.includes('downsample-v1')?`Supported · stride 1–${info.max_downsample}`:'Not supported'],
    ['Sample encoding',info?.features?.includes('sample-encoding-v1')?'Raw 16 / lossless 12 / logarithmic 10 / logarithmic 8 bit':'16-bit container'],
    ['Built', buildDate(info)],
    ['Commit', info?.commit||'Not available'],
    ['Working tree', info?.dirty===true?'Modified (dirty)':info?.dirty===false?'Clean':'Unknown'],
    ['Branch', info?.branch==='HEAD'?'Detached HEAD':info?.branch||'Not available'],
    ['Git description', info?.describe||'Not available'],
    ['Board', info?.board||'Not reported'],
    ['MCU', info?.mcu||'Not reported'],
    ['CPU clock (configured)', clock(info?.cpu_hz)],
    ['CCD clock (configured)', clock(info?.ccd_clock_hz)],
    ['Compiler (GCC)', info?.compiler||'Not reported'],
    ['Build environment', info?.environment||'Not reported'],
    ['USB vendor / product', `${usbId(usb.usbVendorId)} / ${usbId(usb.usbProductId)}`],
    ['Serial link', '500000 baud · 8N1'],
  ];
}
