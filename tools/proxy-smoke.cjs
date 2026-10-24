/** Runtime checks of the PHP proxy; no outbound downloads or real credentials. */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-proxy-test-'));
    const allocator = net.createServer(); await new Promise(r => allocator.listen(0, '127.0.0.1', r));
    const port = allocator.address().port; await new Promise(r => allocator.close(r));
    const args = ['-n', '-d', `sys_temp_dir=${temp}`];
    if (process.env.PHP_CURL_EXTENSION) args.push('-d', `extension=${process.env.PHP_CURL_EXTENSION}`);
    args.push('-S', `127.0.0.1:${port}`, '-t', path.resolve(__dirname,'..'));
    const child = spawn(process.env.PHP_BIN || 'php', args, { env:{ ...process.env, SQ_PROXY_TOKEN:'test-token', SQ_PROXY_ALLOWED_ORIGIN:'https://grader.example', SQ_PROXY_RATE_LIMIT:'100' }, stdio:['ignore','pipe','pipe'] });
    let launchError; child.on('error', e => { launchError=e; });
    const base = `http://127.0.0.1:${port}/proxy.example.php`;
    try {
        let ready = false;
        for (let i=0; i<60; i++) { try { await fetch(base); ready=true; break; } catch (_) { if (launchError) throw launchError; await new Promise(r => setTimeout(r,50)); } }
        assert.ok(ready, 'PHP server started');
        async function check(query, status, options) { const r = await fetch(base+query, options); assert.equal(r.status,status,query); return r; }
        await check('',401);
        await check('?token=test-token',400);
        await check('?token=test-token&url='+encodeURIComponent('http://bestexamhelp.com/test.pdf'),400);
        await check('?token=test-token&url='+encodeURIComponent('https://user:pass@bestexamhelp.com/test.pdf'),400);
        await check('?token=test-token&url='+encodeURIComponent('https://bestexamhelp.com:444/test.pdf'),400);
        await check('?token=test-token&url='+encodeURIComponent('https://127.0.0.1/test.pdf'),403);
        await check('?token=test-token&url='+encodeURIComponent('https://bestexamhelp.com.evil.example/test.pdf'),403);
        await check('?token=test-token',405,{ method:'POST' });
        await check('',403,{ headers:{ Origin:'https://evil.example' } });
        const cors = await check('',204,{ method:'OPTIONS', headers:{ Origin:'https://grader.example' } });
        assert.equal(cors.headers.get('access-control-allow-origin'),'https://grader.example');
        const limiterDirs = fs.readdirSync(temp).filter(name => name.startsWith('sq-proxy-rate-'));
        assert.equal(limiterDirs.length,1);
        const limiterDir = path.join(temp,limiterDirs[0]);
        const files = fs.readdirSync(limiterDir);
        assert.equal(files.length,1,'bounded limiter file reuse');
        // Simulate an expired bucket without waiting a minute.
        const limiter = path.join(limiterDir,files[0]); fs.writeFileSync(limiter,'200001010000|999');
        await check('?token=test-token',400);
        fs.writeFileSync(limiter,new Date().toISOString().replace(/[-:T]/g,'').slice(0,12)+'|100');
        const rate = await check('?token=test-token',429); assert.ok(Number(rate.headers.get('retry-after')) >= 1 && Number(rate.headers.get('retry-after')) <= 60);
        // Array-valued query input must remain machine-readable JSON, never PHP warning output.
        fs.writeFileSync(limiter,'200001010000|0');
        for (const query of ['?token[]=test-token', '?token=test-token&url[]=x']) {
            const response = await check(query,400);
            assert.match((await response.json()).error,/must be a string/);
        }
        const control = await check('?token=test-token&url='+encodeURIComponent('https://bestexamhelp.com/path\nfile.pdf'),400);
        assert.match((await control.json()).error,/control characters/);
        const normal = await check('?token=test-token',400);
        assert.equal(normal.headers.get('vary'),'Origin');
        // Exercise helper functions without outbound network or weakening DNS validation.
        const phpString = value => "'" + value.replaceAll('\\','\\\\').replaceAll("'", "\\'") + "'";
        const php = (expression, file=path.resolve(__dirname,'../proxy.example.php')) => {
            const result = spawnSync(process.env.PHP_BIN || 'php', ['-n','-d',`sys_temp_dir=${temp}`,'-r', 'require '+phpString(file)+'; '+expression], { encoding:'utf8',env:process.env });
            assert.equal(result.status,0,result.stderr);
            assert.equal(result.stderr,'');
            return JSON.parse(result.stdout || 'null');
        };
        const publicChecks=php("$a=[]; foreach (['8.8.8.8','2606:4700:4700::1111','100.64.0.1','192.0.2.1','198.18.0.1','224.0.0.1','2001:db8::1','ff02::1','127.0.0.1','::1'] as $ip) $a[$ip]=isPublicAddress($ip); echo json_encode($a);");
        assert.equal(publicChecks['8.8.8.8'],true); assert.equal(publicChecks['2606:4700:4700::1111'],true);
        Object.entries(publicChecks).slice(2).forEach(([ip,isPublic])=>assert.equal(isPublic,false,ip));
        const canonical=php("echo json_encode(validateTarget('https://BESTEXAMHELP.COM.:443/a.pdf?q=1', static fn ($h) => [['ip'=>'8.8.8.8'],['ip'=>'1.1.1.1']]));");
        assert.equal(canonical.url,'https://bestexamhelp.com/a.pdf?q=1');
        assert.deepEqual(canonical.ips,['8.8.8.8','1.1.1.1']);
        const privateDns=php("echo json_encode(validateTarget('https://bestexamhelp.com/a.pdf', static fn ($h) => [['ip'=>'100.64.0.1']]));");
        assert.match(privateDns.error,/non-public/);
        const aliasTarget=php("echo json_encode(validateTarget('https://bestexamhelp.com/a.pdf', static fn ($h) => $h === 'bestexamhelp.com' ? [['type'=>'CNAME','target'=>'cdn.example.test.']] : [['ip'=>'8.8.8.8']]));");
        assert.equal(aliasTarget.host,'bestexamhelp.com');assert.deepEqual(aliasTarget.ips,['8.8.8.8']);
        const aliasPrivate=php("echo json_encode(validateTarget('https://bestexamhelp.com/a.pdf', static fn ($h) => $h === 'bestexamhelp.com' ? [['type'=>'CNAME','target'=>'private.example.test']] : [['ip'=>'127.0.0.1']]));");
        assert.match(aliasPrivate.error,/non-public/);
        const aliasLoop=php("echo json_encode(validateTarget('https://bestexamhelp.com/a.pdf', static fn ($h) => [['type'=>'CNAME','target'=>'bestexamhelp.com']]));");
        assert.match(aliasLoop.error,/alias loop/);
        const setting=php("putenv('SQ_PROXY_RATE_LIMIT=mistyped'); echo json_encode(integerSetting('SQ_PROXY_RATE_LIMIT',30,1,300));");
        assert.match(setting.error,/Invalid proxy setting/);
        const copied = path.join(temp,'isolated-proxy.php'); fs.copyFileSync(path.resolve(__dirname,'../proxy.example.php'),copied);
        php("$_SERVER['REMOTE_ADDR']='127.0.0.1'; enforceRateLimit(); echo 'null';",copied);
        assert.equal(fs.readdirSync(temp).filter(name => name.startsWith('sq-proxy-rate-')).length,2,'separate deployments do not consume each other’s quota');
        let tlsValidated = false;
        if (process.env.PHP_CURL_EXTENSION) {
            const cert = path.join(temp,'test-cert.pem'), key = path.join(temp,'test-key.pem');
            const openssl = spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=bestexamhelp.com','-addext','subjectAltName=DNS:bestexamhelp.com','-keyout',key,'-out',cert], { encoding:'utf8' });
            assert.equal(openssl.status,0,'OpenSSL is needed for local TLS verification tests');
            const https = require('node:https');
            const sockets = new Set();
            const tlsServer=https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},(request,response)=>{
                if (request.url === '/slow.pdf') return;
                response.setHeader('Content-Type','application/pdf'); response.end('%PDF-1.4\ntrusted local test\n%%EOF');
            });
            tlsServer.on('connection', socket => { sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); });
            await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
            try {
                const tlsPort=tlsServer.address().port;
                const asyncPhp = expression => new Promise((resolve,reject)=>{
                    const code='require '+phpString(path.resolve(__dirname,'../proxy.example.php'))+'; '+expression;
                    const processPhp=spawn(process.env.PHP_BIN || 'php',['-n','-d',`extension=${process.env.PHP_CURL_EXTENSION}`,'-d',`curl.cainfo=${cert}`,'-r',code],{env:process.env,stdio:['ignore','pipe','pipe']});
                    let out='',err='';processPhp.stdout.on('data',data=>out+=data);processPhp.stderr.on('data',data=>err+=data);
                    processPhp.on('error',reject);processPhp.on('exit',status=>{try { assert.equal(status,0,err);assert.equal(err,'');resolve(JSON.parse(out)); }catch(e){reject(e);}});
                });
                const target = suffix => "['url'=>'https://bestexamhelp.com:"+tlsPort+suffix+"','host'=>'bestexamhelp.com','port'=>"+tlsPort+",'ip'=>'127.0.0.2','ips'=>['127.0.0.2','127.0.0.1']]";
                // These helper-level fixtures do not pass through validateTarget: only test TLS
                // and cURL fallback locally, while production still rejects loopback destinations.
                const downloaded=await asyncPhp('echo json_encode(downloadOnce('+target('/test.pdf')+',1048576,2000));');
                assert.equal(downloaded.status,200);assert.match(downloaded.body,/trusted local test/);
                const started=Date.now();
                const timed=await asyncPhp('echo json_encode(downloadOnce('+target('/slow.pdf')+',1048576,200));');
                assert.match(timed.error,/Upstream request failed/);
                assert.ok(Date.now()-started < 1800,'body transfer timeout remains active');
                tlsValidated=true;
            } finally { for (const socket of sockets) socket.destroy();await new Promise(resolve=>tlsServer.close(resolve)); }
        }
        console.log(JSON.stringify({
            php:'runtime checks passed',
            coverage:['authentication','array-valued query errors','protocol/host/port guards','CORS/cache variation','non-global address rejection','canonical and multiple DNS addresses','CDN CNAME resolution with loop/private-address rejection','isolated limiter deployments','bucket rollover','bounded Retry-After','invalid environment settings'],
            trustedLocalTLS:tlsValidated ? ['certificate and hostname verified','first address unavailable -> alternate address succeeds','slow response body hits transfer timeout'] : 'not run: set PHP_CURL_EXTENSION to enable local TLS checks'
        },null,2));
    } finally { child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit',r)); fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(e => { console.error(e); process.exitCode=1; });
