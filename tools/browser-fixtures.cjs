const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
function pdf(text) {
    const stream = `BT /F1 16 Tf 50 750 Td (${text}) Tj ET\n50 640 m 250 640 l 250 700 l S`;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
    let out = '%PDF-1.4\n', offsets = [0];
    objs.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i+1} 0 obj\n${obj}\nendobj\n`; });
    const start = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
}
function multiPagePdf(texts) {
    const objects = [];
    const pageRefs = texts.map((_, i) => `${4 + i * 2} 0 R`);
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${texts.length} >>`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    texts.forEach((text,i) => {
        const stream = `BT /F1 12 Tf 40 740 Td (${String(text).replace(/[\\()]/g, '\\$&')}) Tj ET`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    });
    let out = '%PDF-1.4\n';const offsets=[0];
    objects.forEach((object,i) => { offsets.push(Buffer.byteLength(out));out += `${i+1} 0 obj\n${object}\nendobj\n`; });
    const start=Buffer.byteLength(out);
    out += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
}
function createServer() { return http.createServer((req,res) => {
    const name = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!name.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(name, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm':'application/wasm', '.css': 'text/css', '.html':'text/html', '.woff2':'font/woff2' })[path.extname(name)] || 'application/octet-stream'); res.end(data);
    });
}); }
function browserOptions() {
    const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    return { executablePath, headless:true, args:process.platform === 'linux' ? ['--no-sandbox'] : [] };
}
module.exports = { multiPagePdf, pdf, createServer, browserOptions };
