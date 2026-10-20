const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const bases = {local:'http://127.0.0.1:8876'};
const popupUrl = 'chrome-extension://' + 'a'.repeat(32) + '/popup.html';
function harness({ready=false, boot=true, helperFails=false, wrongService=false, postFails=false, target='local'} = {}) {
  const calls=[], starts=[], posted=[], tabs=[], downloads=[], notices=[];
  let listener, alarm, clicked, clock=0;
  const storage={cultureServerTarget:target, ['apiToken:'+bases.local]:'local-stale'};
  const chrome={
    runtime:{getURL:()=>popupUrl, onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{addListener(fn){listener=fn;}}},
    alarms:{create(){},onAlarm:{addListener(fn){alarm=fn;}}},
    notifications:{onClicked:{addListener(fn){clicked=fn;}},create:async(id)=>notices.push(id)},
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]])), set:async data=>Object.assign(storage,data),remove:async key=>{delete storage[key];}}},
    tabs:{create:async options=>tabs.push(options)}, downloads:{download:async options=>downloads.push(options)}
  };
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    const u=new URL(url), endpoint=u.pathname;
    if(endpoint==='/api/ensure'){
      starts.push(url);
      assert.equal(options.method,'POST'); assert.equal(options.headers['X-Culture-Start'],'1'); assert.equal(options.body,undefined);
      if(helperFails) throw new TypeError('offline');
      if(boot) ready=true;
      return Response.json({ok:true});
    }
    if(!ready) throw new TypeError('offline');
    if(endpoint==='/api/health') return Response.json({ok:true,service:wrongService?'unrelated':'문화자막 큐'});
    const hostTarget='local';
    if(endpoint==='/api/bootstrap') return Response.json({token:hostTarget+'-fresh'});
    const auth=options.headers.get('Authorization');
    assert.ok(auth.startsWith('Bearer '+hostTarget+'-'), 'token crossed server boundary');
    if(auth.endsWith('-stale')) return Response.json({error:'expired'},{status:401});
    if(options.method==='POST'){
      if(postFails) throw new TypeError('lost response');
      posted.push({target:hostTarget,...JSON.parse(options.body)});
      return Response.json({job:{status:'queued'}});
    }
    if(endpoint.startsWith('/api/jobs/')) return Response.json({job:{source_type:'local',watch_url:'/app/watch.html?id=test'}});
    return Response.json({jobs:[{id:'test-job',status:'completed',title:'Test'}]});
  };
  vm.runInNewContext(source,{chrome,fetch,Headers,AbortSignal,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;queueMicrotask(fn);}});
  return {calls,starts,posted,tabs,downloads,notices,storage, request:(msg,sender={})=>new Promise(resolve=>listener(msg,sender,resolve)),alarm:()=>alarm({name:'poll-jobs'}),clicked:id=>clicked(id),setReady:v=>{ready=v;}};
}
const payload={url:'https://www.youtube.com/watch?v=AAAAAAAAAAA',language:'pl',level:'curator'};
const submit=(body=payload)=>({type:'api',path:'/api/jobs',options:{method:'POST',body:JSON.stringify(body)}});
test('warm local: token refresh, exact payload once, no start or helper tab',async()=>{
  const h=harness({ready:true}); assert.equal((await h.request(submit())).ok,true);
  assert.deepEqual(h.posted,[{target:'local',...payload}]); assert.equal(h.starts.length,0); assert.equal(h.tabs.length,0);
});
test('cold local: controller starts server, queue exactly once, no tab',async()=>{
  const h=harness(); assert.equal((await h.request(submit())).ok,true);
  assert.deepEqual(h.starts,['http://127.0.0.1:8875/api/ensure']); assert.equal(h.posted.length,1); assert.equal(h.tabs.length,0);
});
test('concurrent requests share one start but preserve both payloads',async()=>{
  const h=harness(); const other={...payload,language:'pt'};
  assert.ok((await Promise.all([h.request(submit()),h.request(submit(other))])).every(r=>r.ok));
  assert.equal(h.starts.length,1); assert.equal(h.posted.length,2);
  assert.deepEqual(h.posted.map(p=>p.language).sort(),['pl','pt']);
});
test('timeout: no queue, later manual retry works',async()=>{
  const h=harness({boot:false}); assert.equal((await h.request(submit())).ok,false); assert.equal(h.posted.length,0);
  h.setReady(true); assert.equal((await h.request(submit())).ok,true);
});
test('unreachable local helper shows installation guidance and does not queue',async()=>{
  const h=harness({helperFails:true}); const result=await h.request(submit());
  assert.equal(result.ok,false); assert.match(result.error,/실행 도우미/); assert.equal(h.posted.length,0);
});
test('GET, passive alarm and export request never trigger startup',async()=>{
  const h=harness(); await h.request({type:'api',path:'/api/jobs'}); await h.alarm();
  await h.request({...submit(),path:'/api/jobs/id/exports'}); assert.equal(h.starts.length,0);
});
test('wrong service on expected port never queues',async()=>{
  const h=harness({ready:true,wrongService:true}); assert.equal((await h.request(submit())).ok,false); assert.equal(h.posted.length,0);
});
test('ambiguous POST failure is not blindly repeated',async()=>{
  const h=harness({ready:true,postFails:true}); assert.equal((await h.request(submit())).ok,false);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/api/jobs')).length,2); // explicit 401 + one authorized POST
});
test('server selection only from popup and allowlisted target',async()=>{
  const h=harness(); assert.equal((await h.request({type:'setServer',target:'local'},{url:'https://www.youtube.com/'})).ok,false);
  assert.equal((await h.request({type:'setServer',target:'evil'},{url:popupUrl})).ok,false);
  assert.equal((await h.request({type:'setServer',target:'local'},{url:popupUrl})).ok,true);
  assert.equal((await h.request({type:'getServer'})).data.key,'local');
});
test('workbench, download, and completion notification stay on local server',async()=>{
  const h=harness({ready:true}); await h.request({type:'openQueue'});
  assert.equal(h.tabs[0].url,bases.local+'/app/');
  await h.request({type:'downloadUrl',path:'/api/download/ticket'}); assert.equal(h.downloads[0].url,bases.local+'/api/download/ticket');
  await h.alarm(); assert.deepEqual(h.notices,['culture:local:test-job']);
  await h.clicked(h.notices[0]); assert.equal(h.tabs[1].url,bases.local+'/app/watch.html?id=test');
});
test('invalid API and download paths rejected without request',async()=>{
  const h=harness({ready:true}); assert.equal((await h.request({type:'api',path:'http://evil.example'})).ok,false);
  assert.equal((await h.request({type:'downloadUrl',path:'//evil.example'})).ok,false); assert.equal(h.calls.length,0);
});
