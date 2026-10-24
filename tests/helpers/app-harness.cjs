const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const SQCore = require('../../js/core.js');
function harness() {
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { id, value:'', textContent:'', innerHTML:'', disabled:false, hidden:false, children:[], style:{}, appendChild(child){this.children.push(child);}, classList:{add(){},remove(){},toggle(){}}, toggleAttribute(){}, setAttribute(){}, querySelector(){return {className:''};} });
        return nodes.get(id);
    };
    const context = { console, SQCore, AbortController, DOMException, Blob, setTimeout,clearTimeout,
        AppConfig:{ getProxyUrl:()=>'',getLine:()=>({model:'fixture'}) },
        document:{readyState:'loading',addEventListener(){},querySelectorAll:()=>[],getElementById:node, createElement:()=>node('created')},
        pdfjsLib:{ GlobalWorkerOptions:{},OPS:{} },URL:class extends URL {static createObjectURL(){return 'blob:fixture';}static revokeObjectURL(){}},
    };
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../js/app.js'),'utf8'),context);
    return {context,node,run:code=>vm.runInContext(code,context)};
}
module.exports = { harness };
