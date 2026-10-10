import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';
const base='https://mai-da.example.workers.dev';
test('public frontend serves assets without touching the private API', async()=>{
 const response=await worker.fetch(new Request(base),{ASSETS:{fetch:async()=>new Response('actual static asset')},MCD_API:{fetch:()=>assert.fail('Unexpected API call')}});
 assert.equal(await response.text(),'actual static asset');
});
test('proxy preserves personal cookies, CSRF and body, using a fixed private destination and trusted visitor IP',async()=>{
 const body=JSON.stringify({mcdToken:'test-only-token'});let forwarded;
 const response=await worker.fetch(new Request(base+'/api/owner/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','X-Forwarded-For':'spoofed','X-Real-IP':'spoofed',Cookie:'mcd_owner=test-session','X-CSRF-Token':'test-csrf'},body}),{MCD_API:{fetch:async req=>{forwarded=req;return Response.json({saved:true},{headers:{'Set-Cookie':'mcd_owner=new; HttpOnly; Secure; SameSite=Strict','Cache-Control':'no-store'}})}}});
 assert.equal(forwarded.url,'http://127.0.0.1:8799/api/owner/setup');assert.equal(await forwarded.text(),body);
 assert.equal(forwarded.headers.get('Origin'),base);assert.equal(forwarded.headers.get('CF-Connecting-IP'),'192.0.2.1');
 assert.equal(forwarded.headers.get('X-Forwarded-For'),null);assert.equal(forwarded.headers.get('X-Real-IP'),null);
 assert.equal(forwarded.headers.get('Cookie'),'mcd_owner=test-session');assert.equal(forwarded.headers.get('X-CSRF-Token'),'test-csrf');
 assert.match(response.headers.get('Set-Cookie'),/Secure/);assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('cross-site requests, originless writes and missing IP fail before reaching the backend',async()=>{
 for(const [method,headers]of [['GET',{}],['POST',{'CF-Connecting-IP':'192.0.2.1'}],['POST',{Origin:'https://evil.invalid','CF-Connecting-IP':'192.0.2.1'}],['GET',{'Sec-Fetch-Site':'cross-site','CF-Connecting-IP':'192.0.2.1'}]]){
  const r=await worker.fetch(new Request(base+'/api/status',{method,headers}),{MCD_API:{fetch:()=>assert.fail('Unauthorized forwarding')}});assert.equal(r.status,403);
 }
});
test('backend failures do not expose private addresses, credentials or exception details',async()=>{
 const r=await worker.fetch(new Request(base+'/api/status',{headers:{'CF-Connecting-IP':'192.0.2.1'}}),{MCD_API:{fetch:()=>{throw new Error('private-secret-string')}}});
 assert.equal(r.status,503);assert(!(await r.text()).includes('private-secret-string'));
});

test('HTTP pages and token endpoints redirect to HTTPS before any asset or API access',async()=>{
 for(const path of ['/','/api/owner/setup']) {
  const r=await worker.fetch(new Request('http://mai-da.example.workers.dev'+path),{ASSETS:{fetch:()=>assert.fail('Insecure page served')},MCD_API:{fetch:()=>assert.fail('Insecure API called')}});
  assert.equal(r.status,308);assert.equal(r.headers.get('Location'),base+path);
 }
});
