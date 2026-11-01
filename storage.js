let database;
function open() {
  if (!database) database=new Promise((resolve,reject)=>{
    const request=indexedDB.open('spectrum-plotter-web',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('workspace');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return database;
}
export async function loadWorkspace() {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('workspace').objectStore('workspace').get('data');
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
}
export async function saveWorkspace(data) {
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('workspace','readwrite');
    tx.objectStore('workspace').put(data,'data');
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
  });
}
