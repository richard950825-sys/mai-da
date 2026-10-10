import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';
const output=process.env.E2E_OUTPUT||`qa-current/scenario-e2e/faults-${Date.now()}`;
await mkdir(output,{recursive:true});
const server=createApp({port:5193,staticDir:process.env.QA_STATIC_DIR}).createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(5193,'127.0.0.1',r)});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'});page.setDefaultTimeout(5000);
const matrix=[],errors=[];let mode='normal',recommendCalls=0,quoteCalls=0,prepareCalls=0,held,writes=0;
page.on('pageerror',e=>errors.push(e.message));
const nutrition={kcal:600,proteinG:30,fatG:20,carbsG:60,sugarG:null,sodiumMg:600};
const plans=['A','B'].map(id=>({id,title:`测试方案${id}`,foods:[{id,name:`测试鸡肉堡${id}`,quantity:1,productCode:id,nutrition}],nutrition,price:22,priceStatus:'quoted',reasons:[],warnings:[]}));
const err=(code,message)=>({error:{code,message,requestId:'0123456789abcdef01'}});
const respondRecommendations=route=>route.fulfill({json:{recommendations:plans,requestId:'0123456789abcdef01',constraints:{kcalTarget:null,budget:null,goal:'balanced',avoid:[]},warnings:[],source:'offline-fixture'}});
await page.route('**/api/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();const ok=data=>route.fulfill({json:data});
 if(path==='/api/status')return ok({mcd:{configured:true,connected:true},deepseek:{configured:true},ordering:{enabled:false}});
 if(path==='/api/menu/overview')return ok({menuContext:{storeCode:body.storeContext.storeCode,period:'regular',label:'常规餐菜单（午晚餐）',itemCount:2,retrievedAt:new Date().toISOString()}});
 if(path==='/api/stores/search')return ok({stores:[{storeCode:'test-a',name:'测试餐厅A'},{storeCode:'test-b',name:'测试餐厅B'}]});
 if(path==='/api/addresses')return mode==='empty-addresses'?ok({addresses:[]}):route.fulfill({status:503,json:err('MCD_NOT_CONFIGURED','测试配送服务不可用')});
 if(path==='/api/recommendations'){
  recommendCalls++;
  if(mode==='model-429')return route.fulfill({status:429,json:err('DEEPSEEK_HTTP_ERROR','测试模型限流，请稍后再试')});
  if(mode==='mcd-503')return route.fulfill({status:503,json:err('MCD_NETWORK_ERROR','测试麦当劳服务不可用')});
  if(mode==='invalid-json')return route.fulfill({status:200,contentType:'application/json',body:'not-json'});
  if(mode==='invalid-shape')return ok({recommendations:[{}]});
  if(mode==='network')return route.abort('connectionreset');
  if(mode==='held'){held=route;return;}
  return respondRecommendations(route);
 }
 if(path==='/api/quote'){
  quoteCalls++;const letter=body.items[0].productCode;return ok({quote:{id:`q-${quoteCalls}`,currency:'CNY',total:22,productTotal:22,deliveryFee:null,discount:0,tablewareFee:null,expiresAt:new Date(Date.now()+60000).toISOString(),items:[{productCode:letter,productName:`测试鸡肉堡${letter}`,quantity:1}],takeWayList:[{code:'takeout',name:'外带（测试）'}]}});
 }
 if(path==='/api/orders/prepare'){
  prepareCalls++;
  if(mode==='expired'){mode='normal';return route.fulfill({status:409,json:err('QUOTE_EXPIRED','测试报价过期，请重新核价')});}
  return ok({proposal:{id:'test-proposal',quoteId:body.quoteId,storeCode:'test-a',items:[{productCode:'A',name:'测试鸡肉堡A',quantity:1}],total:22,currency:'CNY',service:'pickup',fulfillment:body.fulfillment,confirmationNonce:'test-only',expiresAt:new Date(Date.now()+60000).toISOString()},executionEnabled:false});
 }
 if(path==='/api/orders/confirm'){writes++;return route.abort();}
 return route.fulfill({status:503,json:err('TEST_ROUTE_UNSUPPORTED','测试未配置接口')});
});
const save=()=>writeFile(`${output}/matrix.json`,JSON.stringify({data:'Explicit offline fault injection; no real provider traffic or personal addresses',passed:matrix.every(c=>c.status==='PASS'),matrix,pageErrors:errors,realProviderCalls:0,realOrderWrites:0,blockedOrderAttempts:writes},null,2));
async function step(id,name,fn){mode='normal';held=undefined;const start=Date.now();try{await fn();matrix.push({id,name,status:'PASS',durationMs:Date.now()-start});console.log(`PASS ${id} ${name}`);}catch(e){matrix.push({id,name,status:'FAIL',error:e.message,durationMs:Date.now()-start});console.log(`FAIL ${id} ${name}: ${e.message.slice(0,170)}`);await page.screenshot({path:`${output}/${id}-failure.png`,fullPage:false}).catch(()=>{});}await save();}
async function setup(){await page.goto('http://127.0.0.1:5193/plan');await page.getByRole('button',{name:'不用，直接开始'}).click();await page.getByLabel('所在城市').fill('测试城市');await page.getByRole('button',{name:'查找餐厅'}).click();await page.locator('.store-row').first().click();await page.getByRole('button',{name:'确认这家餐厅'}).click();await page.getByRole('textbox',{name:'描述你的本餐需求'}).fill('测试输入');await page.locator('.consent-row input').check();}
async function generate(){await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.locator('.plan').first().waitFor();}
try{
 for(const [id,fault,pattern] of [['F01','model-429',/测试模型限流/],['F02','mcd-503',/测试麦当劳服务不可用/],['F03','network',/暂时无法连接/]])await step(id,`${fault}提示且可重试`,async()=>{await setup();mode=fault;await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),pattern);mode='normal';await generate();assert.equal(await page.locator('.plan').count(),2);});
 await step('F04','无效JSON显示明确错误并恢复',async()=>{await setup();mode='invalid-json';await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/数据|格式|返回/);assert.doesNotMatch(await page.getByRole('alert').innerText(),/Cannot read|undefined|null/);mode='normal';await generate();});
 await step('F05','无效方案结构不导致白屏',async()=>{await setup();const before=errors.length;mode='invalid-shape';await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(errors.length,before);mode='normal';await generate();});
 await step('F06','迟到推荐不覆盖更换后的餐厅',async()=>{await setup();mode='held';await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.waitForFunction(()=>!!document.querySelector('.planning-loader'));await page.locator('.store-section').getByRole('button',{name:'更换',exact:true}).click();await page.getByRole('button',{name:'查找餐厅'}).click();await page.locator('.store-row').nth(1).click();await page.getByRole('button',{name:'确认这家餐厅'}).click();assert(held);await respondRecommendations(held);mode='normal';await page.waitForTimeout(150);assert.equal(await page.locator('.plan').count(),0);assert.match(await page.locator('.confirmed-store').innerText(),/测试餐厅B/);await generate();});
 await step('F07','快速双击仅发一次规划',async()=>{await setup();mode='held';const before=recommendCalls;await page.locator('.submit-request').dblclick();await page.waitForTimeout(100);assert.equal(recommendCalls-before,1);await respondRecommendations(held);mode='normal';await page.locator('.plan').first().waitFor();});
 await step('F08','删除最后餐品后可重新选择同一方案',async()=>{await setup();await generate();await page.locator('.plan').first().getByRole('button').click();await page.locator('.meal-summary select').waitFor();await page.getByRole('button',{name:'减少测试鸡肉堡A'}).click();await page.getByText('还没选餐',{exact:true}).waitFor();await page.locator('.plan').first().getByRole('button').click();await page.locator('.meal-summary select').waitFor();assert.match(await page.locator('.summary-foods').innerText(),/测试鸡肉堡A/);});
 await step('F09','过期报价自动重新读取后再次复核',async()=>{await setup();await generate();await page.locator('.plan').first().getByRole('button').click();await page.locator('.meal-summary select').selectOption('takeout');const before=quoteCalls;mode='expired';await page.getByRole('button',{name:'确认餐品与金额'}).click();await page.waitForFunction(()=>document.querySelector('.price-summary')?.textContent?.includes('22'));await page.waitForTimeout(200);assert(quoteCalls>before,'Expired quote must trigger a fresh read');await page.locator('.meal-summary select').selectOption('takeout');await page.getByRole('button',{name:'确认餐品与金额'}).click();await page.getByRole('heading',{name:'确认这一餐'}).waitFor();});
 await step('F10','空配送地址和不可用服务均可返回自取',async()=>{await page.goto('http://127.0.0.1:5193/plan');await page.getByRole('button',{name:'不用，直接开始'}).click();await page.getByRole('button',{name:'麦乐送',exact:true}).click();mode='empty-addresses';await page.getByRole('button',{name:'读取我的配送地址'}).click();await page.getByText('账户暂未返回可用的配送地址',{exact:false}).waitFor();mode='normal';await page.getByRole('button',{name:'读取我的配送地址'}).click();await page.getByText('测试配送服务不可用',{exact:false}).waitFor();await page.getByRole('button',{name:'到店取餐',exact:true}).click();await page.getByLabel('所在城市').waitFor();});
 await step('F11','预算零值负值超限及Infinity不允许保存',async()=>{await setup();await page.getByRole('button',{name:'预算',exact:true}).click();for(const value of ['0','-1','10001','1e309']){await page.getByPlaceholder('例如：35').fill(value);assert.equal(await page.getByRole('button',{name:'保存预算'}).isDisabled(),true,`Must reject ${value}`);}});
 assert.equal(writes,0);assert.deepEqual(errors,[]);
}finally{await save();await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify({output,failed:matrix.filter(c=>c.status==='FAIL').map(c=>c.id)}));if(matrix.some(c=>c.status==='FAIL'))process.exitCode=1;}
