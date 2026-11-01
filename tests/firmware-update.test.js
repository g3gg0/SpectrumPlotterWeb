import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setupFirmwareUpdate} from '../firmware-update.js';

class Element extends EventTarget{
  constructor(){super();this.hidden=true;this.disabled=false;this.value='';this.options=[];this.dataset={};this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  setAttribute(){}
  focus(){}
  append(option){this.options.push(option);}
  showModal(){this.open=true;}
  close(){this.open=false;}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  get selectedOptions(){return this.options.filter(option=>option.value===this.value);}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(run){
  const old={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const document=new EventTarget();document.getElementById=get;document.createElement=()=>new Element();
  globalThis.document=document;globalThis.window={showSaveFilePicker:async()=>{throw new Error('Picker not configured');}};
  const binary=new Uint8Array([0,128,1,32,1,1,0,8,10,20,30,40]);
  globalThis.fetch=async url=>{
    if(String(url).endsWith('firmware.bin'))return new Response(binary);
    if(String(url).endsWith('manifest.json'))return Response.json({board:'nucleo_f401re',commit:'a'.repeat(40),filename:'tcd1304-advanced.bin',size:binary.length,sha256:createHash('sha256').update(binary).digest('hex')});
    return Response.json({builds:[{commit:'a'.repeat(40),name:'Firmware test',date:'2026-11-01'}]});
  };
  get('firmware-version').append(Object.assign(new Element(),{value:''}));
  const reports=[],logs=[],calls=[];
  setupFirmwareUpdate({disconnect:async()=>calls.push('disconnect'),report:error=>reports.push(error),log:message=>logs.push(message)});
  try{
    get('connect-options').click();assert.equal(get('connect-menu').hidden,false);
    get('update-firmware').click();await settle();
    assert.equal(get('firmware-dialog').open,true);
    get('firmware-version').value='a'.repeat(40);get('firmware-version').dispatchEvent(new Event('change'));
    for(let i=0;i<30&&get('firmware-save').disabled;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(get('firmware-save').disabled,false);
    await run({get,binary,reports,logs,calls});
  }finally{
    for(const [key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
}
test('save picker offers only BIN and disconnects before writing exact bytes',async()=>{
  await harness(async({get,binary,calls,reports,logs})=>{
    let options,saved;
    window.showSaveFilePicker=async value=>{options=value;calls.push('picker');return {name:'firmware.bin',createWritable:async()=>({write:async data=>{calls.push('write');saved=new Uint8Array(data);},close:async()=>calls.push('close')})};};
    get('firmware-save').click();await settle();
    assert.equal(options.suggestedName,'firmware.bin');
    assert.deepEqual(options.types[0].accept,{'application/octet-stream':['.bin']});
    assert.deepEqual(saved,binary);assert.deepEqual(calls,['picker','disconnect','write','close']);
    assert.equal(reports.length,0);assert.match(logs[0],/not yet been verified/);
  });
});
test('cancelling the picker leaves the device connected and allows retry',async()=>{
  await harness(async({get,calls,reports})=>{
    window.showSaveFilePicker=async()=>{throw new DOMException('Cancelled','AbortError');};
    get('firmware-save').click();await settle();
    assert.deepEqual(calls,[]);assert.equal(reports.length,0);
    assert.equal(get('firmware-save').disabled,false);assert.equal(get('firmware-status').textContent,'Save cancelled.');
  });
});
test('wrong extension and write failure produce visible errors, not success',async()=>{
  await harness(async({get,calls,reports,logs})=>{
    window.showSaveFilePicker=async()=>({name:'firmware.hex'});
    get('firmware-save').click();await settle();
    assert.deepEqual(calls,[]);assert.match(get('firmware-status').textContent,/ending in .bin/);
    window.showSaveFilePicker=async()=>({name:'firmware.bin',createWritable:async()=>({write:async()=>{throw new Error('Drive unavailable');},abort:async()=>calls.push('abort')})});
    get('firmware-save').click();await settle();
    assert.deepEqual(calls,['disconnect','abort']);assert.equal(logs.length,0);assert.equal(reports.length,2);
    assert.equal(get('firmware-status').textContent,'Drive unavailable');assert.ok(get('firmware-status').classes.has('firmware-error'));
  });
});
