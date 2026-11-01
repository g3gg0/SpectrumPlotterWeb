const root='https://g3gg0.github.io/tcd1304-advanced/';
const shaPattern=/^[0-9a-f]{40}$/;
const maxFirmware=512*1024;

async function request(relative){
  let response;
  try{response=await fetch(new URL(relative,root),{cache:'no-store',signal:AbortSignal.timeout(45000)});}
  catch(error){throw new Error(`Cannot reach the GitHub Pages firmware archive: ${error.message}. Enable GitHub Pages in the firmware repository and wait for the publishing workflow.`);}
  if(!response.ok)throw new Error(`Firmware archive unavailable (${response.status}). Enable GitHub Pages in the firmware repository and wait for the publishing workflow.`);
  return response;
}
export async function listFirmwareBuilds(){
  const catalog=await (await request('catalog.json')).json();
  if(!Array.isArray(catalog.builds)||catalog.builds.some(build=>!shaPattern.test(build.commit)||typeof build.name!=='string'||typeof build.date!=='string'))throw new Error('Invalid firmware catalog.');
  return catalog.builds;
}
export async function loadFirmwareBinary(commit){
  if(!shaPattern.test(commit))throw new Error('Invalid firmware commit.');
  const path=`builds/${commit}/`;
  const manifest=await (await request(path+'manifest.json')).json();
  if(manifest.board!=='nucleo_f401re'||manifest.commit!==commit||manifest.filename!=='tcd1304-advanced.bin'||!Number.isSafeInteger(manifest.size)||manifest.size<8||manifest.size>maxFirmware||!/^[0-9a-f]{64}$/.test(manifest.sha256))throw new Error('Invalid firmware manifest or wrong board.');
  const response=await request(path+'firmware.bin');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.length;if(size>manifest.size)throw new Error('Firmware download exceeds the expected size.');
      chunks.push(value);
    }
  }catch(error){await reader.cancel();throw error;}
  finally{reader.releaseLock();}
  if(size!==manifest.size)throw new Error('Incomplete firmware download.');
  const binary=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){binary.set(chunk,offset);offset+=chunk.length;}
  const digest=await crypto.subtle.digest('SHA-256',binary);
  const checksum=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(checksum!==manifest.sha256)throw new Error('Firmware checksum verification failed.');
  const vectors=new DataView(binary.buffer),stack=vectors.getUint32(0,true),reset=vectors.getUint32(4,true);
  if(stack<0x20000000||stack>0x20018000||reset<0x08000001||reset>=0x08080000||!(reset&1))throw new Error('Invalid STM32F401RE firmware vector table.');
  return binary.buffer;
}
