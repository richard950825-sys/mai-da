import { existsSync } from 'node:fs';
import { mkdir,writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
// All API responses are intercepted. This test can never place a merchant order.
const output=process.env.QA_OUTPUT || '/tmp/mcd-ordering-qa';await mkdir(output,{recursive:true});
const port=5191;const base=`http://127.0.0.1:${port}`;
const server=createApp({port,staticDir:process.env.QA_STATIC_DIR}).createServer();await new Promise(r=>server.listen(port,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox']});
const checks=[],errors=[];
const nutrients={kcal:null,proteinG:null,fatG:null,carbsG:null,sugarG:null,sodiumMg:null};
const plan={id:'test-combo',title:'测试牛肉套餐',foods:[{id:'test-combo',name:'测试牛肉套餐',productCode:'C',quantity:1,role:'combo',nutrition:nutrients,components:[{code:'B',name:'测试牛肉堡',quantity:1,role:'main'},{code:'D',name:'测试无糖可乐中杯',quantity:1,role:'drink'},{code:'S',name:'测试中薯条',quantity:1,role:'side'}]}],people:1,officialCombo:true,price:36,priceStatus:'quoted',nutrition:nutrients,reasons:[],warnings:[]};
try {
 for(const scenario of ['success','uncertain','price-changed']){
  const page=await browser.newPage({viewport:scenario==='success'?{width:1440,height:1000}:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));let writes=0,release;let lastRequest;
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;const body=route.request().postDataJSON();const ok=data=>route.fulfill({json:data});
   if(path==='/api/status')return ok({mcd:{configured:true,connected:true},ordering:{enabled:true}});
   if(path==='/api/owner/setup/status')return ok({enabled:false,mcdConfigured:true,csrfToken:'offline-csrf'});
   if(path==='/api/stores/search')return ok({stores:[{storeCode:'T',name:'测试餐厅',address:'测试地址'}]});
   if(path==='/api/menu/overview')return ok({menuContext:{storeCode:'T',period:'regular',label:'常规餐菜单（午晚餐）',itemCount:3,retrievedAt:new Date().toISOString()}});
   if(path==='/api/recommendations'){lastRequest=body;return ok({recommendations:[plan],constraints:{people:1},warnings:[]});}
   if(path==='/api/quote')return ok({quote:{id:'Q',total:36,currency:'CNY',productTotal:36,discount:0,deliveryFee:0,tablewareFee:0,items:[],takeWayList:[{code:'takeout',name:'打包（测试）'}],expiresAt:new Date(Date.now()+300000).toISOString()}});
   if(path==='/api/orders/prepare')return ok({executionEnabled:true,proposal:{id:'P',quoteId:'Q',storeCode:'T',service:'pickup',items:[{productCode:'C',name:'测试牛肉套餐（牛肉堡、无糖可乐中杯、中薯条）',quantity:1}],total:36,currency:'CNY',fulfillment:body.fulfillment,confirmationNonce:'offline-nonce',termsUrl:'https://www.mcdonalds.com.cn/page/terms',cancellationDisclosure:'仅为离线测试的取消规则',expiresAt:new Date(Date.now()+300000).toISOString()}});
   if(path==='/api/orders/confirm'){
    writes++;assert.equal(route.request().headers()['x-csrf-token'],'offline-csrf');assert.equal(body.expectedTotal,36);assert.equal(body.confirmed,true);assert.equal(body.acceptedTerms,true);
    if(scenario==='uncertain')return route.abort();
    if(scenario==='price-changed')return route.fulfill({status:409,json:{error:{code:'PRICE_CHANGED',message:'实付金额已变化，请重新查看并确认'}}});
    release=()=>ok({orderId:'offline-order-123',paymentUrl:'https://mcd.cn/offline-test-payment'});return;
   }
   throw Error('Unmocked route '+path);
  });
  await page.goto(`${base}/plan`);await page.getByRole('button',{name:'不用，直接开始'}).click();
  await page.getByRole('button',{name:'2人',exact:true}).click();assert.equal(await page.getByRole('button',{name:'2人',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('textbox',{name:'描述你的本餐需求'}).fill('单人牛肉无糖可乐');await page.getByRole('button',{name:'1人',exact:true}).click();
  await page.getByLabel('所在城市').fill('测试');await page.getByRole('button',{name:'查找餐厅'}).click();await page.locator('.store-row').first().click();await page.getByRole('button',{name:'确认这家餐厅'}).click();
  await page.locator('.consent-row input').check();await page.getByRole('button',{name:'开始规划',exact:true}).click();await page.locator('.plan').waitFor();assert.equal(lastRequest.preferences.people,1);assert.equal(lastRequest.preferStructuredPeople,true);
  assert.equal(await page.locator('.food-role').allTextContents().then(x=>x.join(',')),'主食,饮品,配餐');
  await page.locator('.plan').getByRole('button').click();await page.locator('.meal-summary select').selectOption('takeout');assert(await page.getByRole('button',{name:'增加测试牛肉套餐',exact:true}).isDisabled());
  await page.getByRole('button',{name:'确认餐品与金额',exact:true}).click();await page.locator('dialog[open]').waitFor();
  const confirm=page.getByRole('button',{name:'确认创建订单，前往支付'});assert(await confirm.isDisabled());assert.equal(writes,0);
  await page.locator('.checkout-review input[type=checkbox]').check();await confirm.click();
  if(scenario==='success'){
   await page.getByRole('button',{name:'正在提交，请勿重复操作…'}).waitFor();assert(await page.getByRole('button',{name:'正在提交，请勿重复操作…'}).isDisabled());
   await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(writes,1);
   await release();await page.getByRole('heading',{name:'订单已创建，待支付'}).waitFor();assert.equal(await page.getByRole('link',{name:'打开麦当劳支付页'}).getAttribute('href'),'https://mcd.cn/offline-test-payment');
   await page.screenshot({path:output+'/offline-order-success.png'});
   await page.reload();await page.getByRole('button',{name:'不用，直接开始'}).click();await page.getByText('订单号：offline-order-123').waitFor();assert.equal(writes,1);
  }else if(scenario==='uncertain'){
   await page.getByText('上次提交结果尚未确认',{exact:false}).waitFor();await page.reload();await page.getByRole('button',{name:'不用，直接开始'}).click();await page.getByText('上次提交结果尚未确认',{exact:false}).waitFor();assert.equal(writes,1);
  }else{
   await page.locator('.checkout-notice').getByText('实付金额已变化',{exact:false}).waitFor();assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(writes,1);assert.equal(await page.evaluate(()=>sessionStorage.getItem('mcd-current-order')),null);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks.push(scenario);await page.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks,browser:'Playwright Chromium; Browser plugin unavailable',viewports:['1440x1000','390x844'],providerWrites:0}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
