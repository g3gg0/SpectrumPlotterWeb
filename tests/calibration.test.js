import test from 'node:test';
import assert from 'node:assert/strict';
import {CalibrationAverage,calibrationSignal,calibrationFit} from '../calibration.js';
import {parseConfig,polynomial} from '../data.js';
import {PIXELS} from '../protocol.js';

const frame=value=>new Uint16Array(PIXELS).fill(value);
test('calibration averages full raw frames with fractional precision',()=>{
  const average=new CalibrationAverage();average.add(frame(100));average.add(frame(101));
  assert.equal(average.count,2);assert.equal(average.mean()[0],100.5);assert.equal(average.mean().length,PIXELS);
  assert.equal(average.statistics().peak,101);assert.equal(average.statistics().sampleCount,PIXELS*2);
  const raw=frame(100);raw[1000]=105;
  const signal=calibrationSignal(Array.from(raw),average.mean());
  assert.equal(signal.x[1000],1000);assert.equal(signal.x.at(-1),3693);assert.equal(signal.y[1000],4.5);assert.equal(signal.y[0],0);
  assert.throws(()=>calibrationSignal(average.mean(),average.mean()),/Kein Signal/);
});
test('saturation or invalid data cannot be hidden inside calibration averages',()=>{
  const average=new CalibrationAverage();average.add(frame(1));
  const clipped=frame(0);clipped[3000]=4095;
  assert.throws(()=>average.add(clipped),/ADC-Sättigung/);assert.equal(average.count,1);
  assert.throws(()=>average.add(frame(5000)),/Ungültige ADC/);assert.equal(average.count,1);
  assert.throws(()=>average.add(new Uint16Array(20)),/Unvollständige/);
  assert.equal(average.mean()[0],1);
});
test('several reference spectra contribute their original pixel coordinates to one fit',()=>{
  const references=[{id:'a',name:'Referenz A',points:[{pixel:600,wavelength:410},{pixel:1800,wavelength:530}]},{id:'b',name:'Referenz B',points:[{pixel:3000,wavelength:650},{pixel:3500,wavelength:700}]}];
  const fit=calibrationFit(references);
  assert.equal(fit.degree,3);assert.equal(fit.points.length,4);assert.ok(fit.rms<1e-9);
  assert.ok(Math.abs(polynomial(fit.coefficients,2000)-550)<1e-9);
  assert.equal(fit.points[2].reference,'Referenz B');
  assert.equal(calibrationFit(references,1).degree,1);
});
test('underconstrained, conflicting, and folding wavelength maps cannot be applied',()=>{
  assert.throws(()=>calibrationFit([{name:'A',points:[{pixel:100,wavelength:400}]}]),/zwei/);
  assert.throws(()=>calibrationFit([{name:'A',points:[{pixel:100,wavelength:400},{pixel:100,wavelength:500}]}]),/verschiedenen/);
  assert.throws(()=>calibrationFit([{name:'A',points:[{pixel:0,wavelength:500},{pixel:1000,wavelength:550},{pixel:2000,wavelength:500}]}]),/kehrt/);
  assert.throws(()=>calibrationFit([{name:'A',points:[{pixel:-1,wavelength:400},{pixel:3000,wavelength:600}]}]),/Pixel/);
  const repeated=[{name:'A',points:[{pixel:0,wavelength:400},{pixel:3000,wavelength:700}]},{name:'B',points:[{pixel:0,wavelength:400}]}];
  assert.equal(calibrationFit(repeated).degree,1);
});
test('native averaged dark frames retain fractions alongside a rounded C# fallback',()=>{
  const darkFrame=Array(PIXELS).fill(100.5);
  const native=parseConfig({lambda:[350,.1,0,0],darkFrame,DarkFrame:Array(PIXELS).fill(101)});
  assert.equal(native.darkFrame[0],100.5);
  assert.equal(parseConfig({DarkFrame:Array(PIXELS).fill(101)}).darkFrame[0],101);
});
