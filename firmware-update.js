export function setupFirmwareUpdate({disconnect,report,log}){
  const $=id=>document.getElementById(id);
  const dialog=$('firmware-dialog'),menu=$('connect-menu'),toggle=$('connect-options');
  const select=$('firmware-version'),status=$('firmware-status'),save=$('firmware-save'),more=$('firmware-more');
  let nextPage=1,bytes=null,selection=0,busy=false,loading=false;
  function closeMenu(){menu.hidden=true;toggle.setAttribute('aria-expanded','false');}
  function message(text,error=false){status.textContent=text;status.classList.toggle('firmware-error',error);}
  async function request(path){
    const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(45000)});
    if(!response.ok){
      const type=response.headers.get('content-type')||'';
      const detail=type.includes('application/json')?(await response.json()).error:null;
      throw new Error(detail||'Firmware updates require the local Node server (npm start). GitHub may also be unavailable.');
    }
    return response;
  }
  async function load(){
    if(loading||!nextPage)return;
    loading=true;
    more.disabled=true;message('Loading published commit builds...');
    try{
      const {builds,nextPage:next}=await (await request(`/api/firmware/releases?page=${nextPage}`)).json();
      for(const build of builds){
        const option=document.createElement('option');option.value=String(build.id);
        option.textContent=`${build.date?.slice(0,10)||''} · ${build.commit.slice(0,12)} · ${build.name}`;
        option.dataset.commit=build.commit;select.append(option);
      }
      nextPage=next;more.hidden=!next;select.disabled=select.options.length===1;
      message(select.disabled?'No published commit builds yet. Push the firmware workflow to GitHub first.':'Choose a build to download and verify.');
    }catch(error){message(error.message,true);report(error);}
    finally{loading=false;more.disabled=busy;}
  }
  toggle.addEventListener('click',()=>{menu.hidden=!menu.hidden;toggle.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden)$('update-firmware').focus();});
  document.addEventListener('click',event=>{if(!event.target.closest('.connect-split'))closeMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden){closeMenu();toggle.focus();}});
  $('update-firmware').addEventListener('click',()=>{
    closeMenu();dialog.showModal();
    if(!window.showSaveFilePicker){message('Saving directly to the board requires desktop Chrome or Edge on localhost/HTTPS.',true);return;}
    if(select.options.length===1)load();
  });
  $('close-firmware').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  more.addEventListener('click',load);
  select.addEventListener('change',async()=>{
    const revision=++selection;bytes=null;save.disabled=true;
    if(!select.value){message('Choose a firmware build.');return;}
    message('Downloading firmware.bin and checking board and SHA-256 checksum...');
    try{
      const response=await request(`/api/firmware/releases/${select.value}/binary`);
      const data=await response.arrayBuffer();
      if(revision!==selection)return;
      if(data.byteLength<8||data.byteLength>512*1024)throw new Error('Invalid firmware binary size.');
      bytes=data;save.disabled=!window.showSaveFilePicker;
      message(`Ready: ${select.selectedOptions[0].dataset.commit} (${data.byteLength.toLocaleString()} bytes). Select NODE_F401RE in the Save As dialog.`);
    }catch(error){if(revision===selection){message(error.message,true);report(error);}}
  });
  save.addEventListener('click',async()=>{
    if(!bytes||busy)return;
    busy=true;save.disabled=true;select.disabled=true;more.disabled=true;$('close-firmware').disabled=true;
    let writable;
    try{
      const handle=await window.showSaveFilePicker({suggestedName:'firmware.bin',types:[{description:'STM32 firmware binary',accept:{'application/octet-stream':['.bin']}}],excludeAcceptAllOption:true});
      if(!handle.name.toLowerCase().endsWith('.bin'))throw new Error('Choose a filename ending in .bin.');
      await disconnect();
      writable=await handle.createWritable();await writable.write(bytes);await writable.close();writable=null;
      message('firmware.bin written. Wait for the ST-Link activity LED to stop, check FAIL.TXT on the drive, then reconnect to inspect the reported commit. Writing the file alone does not confirm flashing succeeded.');
      log('Firmware binary saved. Board programming has not yet been verified.');
    }catch(error){
      if(writable){try{await writable.abort();}catch(abortError){report(abortError);}}
      if(error.name==='AbortError')message('Save cancelled.');else{message(error.message,true);report(error);}
    }finally{
      busy=false;save.disabled=!bytes;select.disabled=false;more.disabled=false;$('close-firmware').disabled=false;
    }
  });
}
