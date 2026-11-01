import {createHash} from 'node:crypto';

const repository='https://api.github.com/repos/g3gg0/tcd1304-advanced';
const maxFirmware=512*1024;

async function github(url,fetcher){
  const response=await fetcher(url,{headers:{Accept:'application/vnd.github+json','User-Agent':'SpectrumPlotterWeb'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`GitHub request failed (${response.status}). Try again later if the API rate limit has been reached.`);
  return response;
}
function asset(release,name){
  const result=release.assets?.find(item=>item.name===name);
  if(!result||!Number.isSafeInteger(result.id)||result.size<1||result.size>maxFirmware)throw new Error(`Release is missing a valid ${name}.`);
  return result;
}
async function assetBytes(item,fetcher){
  const response=await fetcher(`${repository}/releases/assets/${item.id}`,{headers:{Accept:'application/octet-stream','User-Agent':'SpectrumPlotterWeb'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Firmware download failed (${response.status}).`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxFirmware)throw new Error('Firmware download exceeds the board flash size.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==item.size)throw new Error('Incomplete firmware download.');
  return bytes;
}

export async function firmwareRequest(url,fetcher=fetch){
  if(url.pathname==='/api/firmware/releases'){
    const page=url.searchParams.get('page')||'1';
    if(!/^[1-9]\d{0,3}$/.test(page))throw new Error('Invalid release page.');
    const releases=await (await github(`${repository}/releases?per_page=30&page=${page}`,fetcher)).json();
    if(!Array.isArray(releases))throw new Error('Invalid GitHub release response.');
    const builds=releases.filter(r=>!r.draft&&/^build-[0-9a-f]{40}$/.test(r.tag_name)&&r.assets?.some(a=>a.name==='manifest.json')&&r.assets.some(a=>a.name==='tcd1304-advanced.bin')).map(r=>({
      id:r.id,commit:r.tag_name.slice(6),name:r.name||r.tag_name,date:r.published_at
    }));
    return {type:'application/json',body:JSON.stringify({builds,nextPage:releases.length===30?Number(page)+1:null})};
  }
  const match=/^\/api\/firmware\/releases\/([1-9]\d*)\/binary$/.exec(url.pathname);
  if(!match)return null;
  const release=await (await github(`${repository}/releases/${match[1]}`,fetcher)).json();
  if(release.draft||!/^build-[0-9a-f]{40}$/.test(release.tag_name))throw new Error('Not a published firmware commit build.');
  const manifest=JSON.parse((await assetBytes(asset(release,'manifest.json'),fetcher)).toString('utf8'));
  if(manifest.board!=='nucleo_f401re'||manifest.commit!==release.tag_name.slice(6)||manifest.filename!=='tcd1304-advanced.bin'||!Number.isSafeInteger(manifest.size)||manifest.size<8||manifest.size>maxFirmware||!/^[0-9a-f]{64}$/.test(manifest.sha256))throw new Error('Invalid firmware manifest or wrong board.');
  const bytes=await assetBytes(asset(release,manifest.filename),fetcher);
  if(bytes.length!==manifest.size||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('Firmware checksum verification failed.');
  const stack=bytes.readUInt32LE(0),reset=bytes.readUInt32LE(4);
  if(stack<0x20000000||stack>0x20018000||reset<0x08000001||reset>=0x08080000||!(reset&1))throw new Error('Invalid STM32F401RE firmware vector table.');
  return {type:'application/octet-stream',body:bytes};
}
