/** Report startup failures instead of leaving a page whose controls never initialize. */
const status = document.getElementById('startupStatus');
const message = document.getElementById('startupMessage');
const retry = document.getElementById('retryStartupBtn');
retry?.addEventListener('click', () => location.reload());
try {
    if (!globalThis.SQCore || !globalThis.AppConfig) throw new Error('应用脚本未能完整加载');
    const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
    globalThis.pdfjsLib = pdfjsLib;
    await import('./app.js');
    if (status) status.hidden = true;
} catch (_) {
    if (message) message.textContent = '批改工具加载失败。请检查网络或静态文件是否完整，并确认服务器正确提供 .mjs 文件，然后重新加载。';
    if (status) { status.hidden = false; status.setAttribute('role', 'alert'); }
    if (retry) retry.hidden = false;
}
