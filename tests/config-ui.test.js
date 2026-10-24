const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

class MemoryStorage {
    constructor(){this.data=new Map();}
    getItem(key){return this.data.get(key)??null;}
    setItem(key,value){this.data.set(key,String(value));}
    removeItem(key){this.data.delete(key);}
}
function settingsUI(storageFactory=()=>new MemoryStorage()) {
    const nodes=new Map(),alerts=[];let saved=0;
    const node=(id)=>{
        const el={id,value:'',checked:false,disabled:false,style:{display:'none'},listeners:{},
            addEventListener(name,fn){this.listeners[name]=fn;},focus(){document.activeElement=this;},
            click(){this.listeners.click?.({target:this});}};
        nodes.set(id,el);return el;
    };
    for(const id of ['settingsBtn','bannerConfigBtn','cfgCancelBtn','cfgSaveBtn','cfgClearBtn','cfg-proxyUrl','cfgRememberKeys','settingsModal'])node(id);
    const lines=['line1','line2','deepseek'].map(line=>{
        const fields=['label','baseUrl','apiKey','model'].map(field=>{const el=node(`${line}-${field}`);el.dataset={field};return el;});
        return{dataset:{line},querySelectorAll(){return fields;}};
    });
    const document={activeElement:null,getElementById(id){return nodes.get(id);},querySelectorAll(selector){return selector==='.line-config'?lines:[];}};
    const modal=nodes.get('settingsModal');
    modal.querySelector=()=>nodes.get('line1-label');
    modal.querySelectorAll=selector=>selector==='[data-field="apiKey"]'?lines.map(line=>nodes.get(line.dataset.line+'-apiKey')):[...nodes.values()];
    const context={document,localStorage:storageFactory(),sessionStorage:storageFactory(),URL,AbortController,setTimeout,clearTimeout,alert:message=>alerts.push(message)};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/config.js'),'utf8'),context);
    const api=context.AppConfig;api.initUI(()=>saved++);
    return{api,nodes,alerts,context,get saved(){return saved;}};
}
function usable(){return{lines:{line1:{baseUrl:'https://api.example.test/v1',apiKey:'fixture-only',model:'vision-model'}},rememberKeys:false};}

test('settings cannot save a malformed API URL and dismiss the only visible error opportunity',()=>{
    const ui=settingsUI();ui.api.save(usable());ui.api.openModal();
    ui.nodes.get('line1-baseUrl').value='not a URL';ui.nodes.get('cfgSaveBtn').click();
    assert.match(ui.alerts[0],/URL 无效/);
    assert.equal(ui.saved,0);assert.equal(ui.nodes.get('settingsModal').style.display,'flex');
    assert.equal(ui.api.getLine('line1').baseUrl,'https://api.example.test/v1');
});

test('forget button clears cached credentials and refreshes both modal fields and app callback',()=>{
    const ui=settingsUI();ui.api.save(usable());ui.api.openModal();
    assert.equal(ui.nodes.get('line1-apiKey').value,'fixture-only');
    ui.nodes.get('cfgClearBtn').click();
    assert.equal(ui.saved,1);assert.equal(ui.nodes.get('line1-apiKey').value,'');
    assert.equal(ui.nodes.get('line1-baseUrl').value,'https://api.example.test/v1');
    assert.equal(ui.api.isConfigured(),false);
});

test('closing settings removes password DOM values while opening restores saved configuration',()=>{
    const ui=settingsUI();ui.api.save(usable());ui.api.openModal();ui.nodes.get('cfgCancelBtn').click();
    assert.equal(ui.nodes.get('line1-apiKey').value,'');
    ui.api.openModal();assert.equal(ui.nodes.get('line1-apiKey').value,'fixture-only');
});

test('browser storage rejection is reported to the user instead of silently promising saved settings',()=>{
    const ui=settingsUI(()=>({getItem(){return null;},setItem(){throw new Error('blocked');},removeItem(){}}));
    ui.api.save(usable());ui.api.openModal();ui.nodes.get('cfgSaveBtn').click();
    assert.equal(ui.saved,1);assert.ok(ui.alerts.some(text=>text.includes('当前页面有效')));
    assert.equal(ui.api.isConfigured(),true);
});

test('R3 partially configured optional routes cannot be saved as if usable',()=>{
 const ui=settingsUI();ui.api.save(usable());ui.api.openModal();ui.nodes.get('line2-baseUrl').value='https://second.example/v1';ui.nodes.get('cfgSaveBtn').click();
 assert.equal(ui.saved,0);assert.match(ui.alerts[0],/填写不完整/);assert.equal(ui.nodes.get('settingsModal').style.display,'flex');
});
test('R3 closing settings scrubs proxy tokens from hidden text inputs and reopening restores them',()=>{
 const ui=settingsUI();const cfg=usable();cfg.proxyUrl='https://proxy.example/?token=fixture&url=';ui.api.save(cfg);ui.api.openModal();ui.nodes.get('cfgCancelBtn').click();
 assert.equal(ui.nodes.get('cfg-proxyUrl').value,'');ui.api.openModal();assert.equal(ui.nodes.get('cfg-proxyUrl').value,cfg.proxyUrl);
});
test('R3 dialog background cannot be focused and pre-existing inert state is restored',()=>{
 const ui=settingsUI();ui.api.save(usable());const background={inert:false},locked={inert:true};ui.context.document.body={children:[background,locked,ui.nodes.get('settingsModal')]};
 ui.api.openModal();assert.equal(background.inert,true);ui.nodes.get('cfgCancelBtn').click();assert.equal(background.inert,false);assert.equal(locked.inert,true);
});
