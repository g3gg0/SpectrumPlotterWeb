// TCD1304 firmware uses ADC1, 12-bit resolution, right-aligned samples.
export const ADC_BITS = 12;
export const ADC_FULL_SCALE = (1 << ADC_BITS) - 1;
export const ADC_LOW_PERCENT = 5;
export const ADC_HIGH_PERCENT = 95;

function summarize({minimum,peak,sampleCount,clippedSamples,invalidSamples}) {
  const utilizationPercent=invalidSamples?null:peak/ADC_FULL_SCALE*100;
  const status=invalidSamples?'invalid':clippedSamples?'saturated':utilizationPercent>=ADC_HIGH_PERCENT?'near-limit':utilizationPercent<ADC_LOW_PERCENT?'low':'ok';
  return {version:1,bits:ADC_BITS,fullScale:ADC_FULL_SCALE,minimum,peak,sampleCount,clippedSamples,invalidSamples,utilizationPercent,status};
}

export function adcStatistics(raw) {
  if (!raw?.length) return null;
  let minimum=Infinity,peak=-Infinity,clippedSamples=0,invalidSamples=0;
  for (const value of raw) {
    if (!Number.isInteger(value)||value<0||value>ADC_FULL_SCALE) invalidSamples++;
    if (Number.isFinite(value)) { minimum=Math.min(minimum,value);peak=Math.max(peak,value); }
    if (value===ADC_FULL_SCALE) clippedSamples++;
  }
  return summarize({minimum:Number.isFinite(minimum)?minimum:null,peak:Number.isFinite(peak)?peak:null,sampleCount:raw.length,clippedSamples,invalidSamples});
}

// Captures contain a summary, not raw samples. Recompute derived fields on import.
export function readAdcStatistics(summary) {
  if (!summary||summary.version!==1||summary.bits!==ADC_BITS||summary.fullScale!==ADC_FULL_SCALE) return null;
  const {minimum,peak,sampleCount,clippedSamples,invalidSamples}=summary;
  if (![sampleCount,clippedSamples,invalidSamples].every(Number.isSafeInteger)||sampleCount<1||clippedSamples<0||invalidSamples<0||clippedSamples+invalidSamples>sampleCount) return null;
  if ((!Number.isFinite(minimum)||!Number.isFinite(peak)||minimum>peak)&&!invalidSamples) return null;
  if (!invalidSamples&&(!Number.isInteger(minimum)||!Number.isInteger(peak)||minimum<0||peak>ADC_FULL_SCALE||(peak===ADC_FULL_SCALE)!==(clippedSamples>0))) return null;
  return summarize({minimum,peak,sampleCount,clippedSamples,invalidSamples});
}

export function adcPresentation(stats) {
  if (!stats) return {status:'unavailable',usage:'ADC —',counts:'Raw ADC data unavailable',label:'No exposure assessment',error:null};
  const {status,peak,fullScale,sampleCount,clippedSamples,invalidSamples,utilizationPercent}=stats;
  const usage=utilizationPercent===null?'ADC invalid':`${utilizationPercent.toFixed(2)}% FS`;
  const counts=`${peak??'—'} / ${fullScale} counts`;
  const labels={low:'Low level · too dark?',ok:'ADC level OK','near-limit':'Near limit · reduce signal',saturated:'ERROR · ADC SATURATED',invalid:'ERROR · INVALID ADC DATA'};
  const error=status==='saturated'?`ADC SATURATED — ${clippedSamples} of ${sampleCount} samples reached ${fullScale}. Reduce integration time or illumination.`:status==='invalid'?`INVALID ADC DATA — ${invalidSamples} of ${sampleCount} samples are outside the unsigned 12-bit range (0–${fullScale}). Check acquisition and data transfer.`:null;
  return {status,usage,counts,label:labels[status],error};
}
