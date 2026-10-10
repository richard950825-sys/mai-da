import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';
import assert from 'node:assert/strict';
// Offline fixture-only regression. All API traffic is intercepted; no credentials or live providers.
const server = createApp({port:5189,staticDir:process.env.QA_STATIC_DIR}).createServer();
await new Promise(r=>server.listen(5189,'127.0.0.1',r));
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : '/usr/bin/google-chrome'),headless:true,args:['--no-sandbox']});
const errors=[];let pendingPrepare;let deferPrepare=true;let writes=0;
const nutrient={kcal:600,proteinG:40,fatG:20,carbsG:60,sugarG:null,sodiumMg:800};
const plans=['A','B'].map(letter=>({id:letter,title:`测试方案${letter}`,foods:[{id:letter,name:`测试食品${letter}`,quantity:1,nutrition:nutrient,productCode:letter}],nutrition:nutrient,price:22,priceStatus:'quoted',reasons:[],warnings:[]}));
const proposal=letter=>({proposal:{id:`p${letter}`,quoteId:`q${letter}`,storeCode:'s-test',service:'pickup',items:[{productCode:letter,name:`测试食品${letter}`,quantity:1}],fulfillment:{takeWayCode:'takeout'},confirmationNonce:'test-only-nonce',total:22,currency:'CNY',expiresAt:new Date(Date.now()+60000).toISOString()},executionEnabled:false});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const body=route.request().postDataJSON();const ok=data=>route.fulfill({json:data});
  if(endpoint==='/api/status')return ok({mcd:{configured:true,connected:true},deepseek:{configured:true},ordering:{enabled:false}});
  if(endpoint==='/api/menu/overview')return ok({menuContext:{storeCode:body.storeContext.storeCode,period:'regular',label:'常规餐菜单（午晚餐）',itemCount:2,retrievedAt:new Date().toISOString()}});
  if(endpoint==='/api/stores/search')return ok({stores:[{storeCode:'s-test',name:'测试门店',address:'仅测试地址'}]});
  if(endpoint==='/api/recommendations')return ok({recommendations:plans,warnings:[],constraints:{kcalTarget:null},retrievedAt:new Date().toISOString()});
  if(endpoint==='/api/quote'){const letter=body.items[0].productCode;return ok({quote:{id:`q${letter}`,currency:'CNY',total:22,productTotal:null,deliveryFee:null,discount:null,tablewareFee:null,expiresAt:new Date(Date.now()+60000).toISOString(),items:[],takeWayList:[{code:'takeout',name:'外带（测试）'}]}});}
  if(endpoint==='/api/orders/prepare'){const letter=body.quoteId.slice(1);if(deferPrepare){pendingPrepare={route,letter};return;}return ok(proposal(letter));}
  if(endpoint==='/api/orders/confirm'){writes++;throw Error('Order confirm must not be called');}
  return route.fulfill({status:503,json:{error:{message:'Test route not configured'}}});
 });
 await page.goto('http://127.0.0.1:5189/plan');assert.equal(await page.title(),'麦搭 · 这一餐，刚刚好');
 await page.getByRole('button',{name:'不用，直接开始'}).click();
 await page.getByLabel('所在城市').fill('测试城市');await page.getByRole('button',{name:'查找餐厅'}).click();
 await page.locator('.store-row').first().click();await page.getByRole('button',{name:'确认这家餐厅'}).click();
 await page.getByRole('textbox',{name:'描述你的本餐需求'}).fill('测试需求');await page.locator('.consent-row input').check();await page.getByRole('button',{name:'开始规划',exact:true}).click();
 await page.locator('.plan').nth(0).getByRole('button').click();await page.locator('.meal-summary select').selectOption('takeout');
 assert.match(await page.locator('.price-summary').innerText(),/未知/);
 await page.getByRole('button',{name:'确认餐品与金额'}).click();
 await page.waitForFunction(()=>document.querySelector('.review-button')?.disabled);
 assert(pendingPrepare,'prepare A was captured');
 await page.locator('.plan').nth(1).getByRole('button').click();
 await page.locator('.summary-foods').getByText('测试食品B').waitFor();
 await page.locator('.meal-summary select').selectOption('takeout');
 await pendingPrepare.route.fulfill({json:proposal(pendingPrepare.letter)});deferPrepare=false;
 await page.waitForTimeout(150);
 assert.equal(await page.locator('dialog[open]').count(),0,'late A must not open a review of B');
 await page.getByRole('button',{name:'确认餐品与金额'}).click();
 await page.getByRole('heading',{name:'确认这一餐'}).waitFor();
 const review=await page.locator('.checkout-review').innerText();assert.match(review,/测试食品B/);assert(!review.includes('测试食品A'));
 await page.screenshot({path:`${process.env.QA_OUTPUT || '/tmp'}/mcd-checkout-race.png`,fullPage:true});
 assert.equal(writes,0);assert.deepEqual(errors,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
 console.log(JSON.stringify({passed:true,environment:'Playwright Chromium; Browser plugin absent',url:'http://127.0.0.1:5189',viewport:'1440x1000',checks:['nullable price fields render 未知','late prepare response ignored after plan change','review uses immutable proposal B items','no order submission','no runtime errors'],screenshot:`${process.env.QA_OUTPUT || '/tmp'}/mcd-checkout-race.png`,data:'offline fixtures only'}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
