import test from 'node:test';
import assert from 'node:assert/strict';
import {adcStatistics,readAdcStatistics,adcPresentation} from '../adc.js';
import {correct,DEFAULTS,exportCapture,parseCapture} from '../data.js';

test('ADC usage measures actual 12-bit peak, not a normalized plot maximum',()=>{
  const raw=Uint16Array.of(0,4,0,1),adc=adcStatistics(raw);
  assert.equal(adc.peak,4);assert.equal(adc.fullScale,4095);assert.equal(adc.minimum,0);
  assert.equal(adc.status,'low');assert.equal(adcPresentation(adc).usage,'0.10% FS');
  assert.equal(adc.clippedSamples,0);
  const config={...DEFAULTS,normalize:true,resample:4};
  assert.equal(Math.max(...correct(raw,config).y),1);
  assert.equal(adc.peak,4);assert.equal(adc.status,'low');
});
test('zero, normal and near-limit readings have distinct exposure states',()=>{
  assert.equal(adcStatistics([0,0]).utilizationPercent,0);
  assert.equal(adcStatistics([0,0]).status,'low');
  assert.equal(adcStatistics([0,2048]).status,'ok');
  assert.equal(adcPresentation(adcStatistics([0,2048])).usage,'50.01% FS');
  assert.equal(adcStatistics([0,3891]).status,'near-limit');
  assert.equal(adcStatistics([0,3890]).status,'ok');
  assert.equal(adcStatistics([4094,0]).status,'near-limit');
});
test('one saturated sample flags an error even when processing hides it',()=>{
  const raw=Uint16Array.of(0,4095,0,0),adc=adcStatistics(raw);
  assert.equal(adc.status,'saturated');assert.equal(adc.clippedSamples,1);
  assert.match(adcPresentation(adc).error,/1 of 4 samples reached 4095/);
  const processed=correct(raw,{...DEFAULTS,normalize:true,resample:2},raw);
  assert.deepEqual(processed.y,[0,0]);assert.equal(adc.status,'saturated');
  assert.equal(adcStatistics([4095,4095]).clippedSamples,2);
});
test('out-of-range data is an acquisition error, not a brightness reading',()=>{
  for(const value of [4096,65535,-1,1.5,NaN]){
    const adc=adcStatistics([0,value]);assert.equal(adc.status,'invalid');assert.equal(adc.utilizationPercent,null);
    assert.match(adcPresentation(adc).error,/INVALID ADC DATA/);
  }
  assert.equal(adcStatistics([]),null);assert.equal(adcPresentation(null).status,'unavailable');
});
test('capture export retains pre-processing ADC statistics and import recomputes status',()=>{
  const adc=adcStatistics([0,4095,0,1]);
  const exported=exportCapture({name:'Clipped',x:[450,451],y:[0,1],metadata:{adc,averages:1}});
  const capture=parseCapture(JSON.parse(JSON.stringify(exported)));
  assert.equal(readAdcStatistics(capture.metadata.adc).status,'saturated');
  assert.equal(readAdcStatistics({...adc,status:'ok',utilizationPercent:0}).status,'saturated');
  assert.equal(readAdcStatistics({...adc,bits:16}),null);
  assert.equal(readAdcStatistics({...adc,clippedSamples:0}),null);
  assert.equal(readAdcStatistics({...adc,clippedSamples:5}),null);
  assert.equal(readAdcStatistics(undefined),null);
});
