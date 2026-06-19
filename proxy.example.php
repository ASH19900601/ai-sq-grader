<?php
/**
 * proxy.example.php — 可选的 PDF 下载代理示例（自行部署）
 *
 * 用途：浏览器跨域(CORS)限制无法直接抓取第三方题库站的 PDF。
 *      部署本文件到你自己的 PHP 服务器后，在前端「配置」里把
 *      "PDF 下载代理 URL" 填成：  https://your-domain/proxy.php?url=
 *      前端会把目标 PDF 地址 encodeURIComponent 后拼接在末尾。
 *
 * 安全：仅允许白名单域名，且校验返回内容必须是 PDF。
 * 注意：本文件不含任何密钥，可安全公开。
 */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET');

$url = $_GET['url'] ?? '';

$allowed_domains = [
    'filestore.aqa.org.uk',
    'oxfordaqa.com',
    'bestexamhelp.com',
    'gceguide.com',
    'mmerevise.co.uk',
    'pastpapers.co',
];

if (!$url) {
    http_response_code(400);
    die(json_encode(['error' => 'Missing url parameter']));
}

$parsed = parse_url($url);
$host = $parsed['host'] ?? '';
$allowed = false;
foreach ($allowed_domains as $d) {
    if ($host === $d || str_ends_with($host, '.' . $d)) { $allowed = true; break; }
}
if (!$allowed) {
    http_response_code(403);
    die(json_encode(['error' => "Domain not allowed: $host"]));
}

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    CURLOPT_HTTPHEADER     => [
        'Accept: application/pdf,*/*',
        'Accept-Language: en-US,en;q=0.9',
    ],
]);

$body   = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err    = curl_error($ch);
curl_close($ch);

if ($err) {
    http_response_code(502);
    die(json_encode(['error' => "curl error: $err"]));
}
if ($status !== 200) {
    http_response_code($status);
    die(json_encode(['error' => "Upstream returned HTTP $status"]));
}
if (substr($body, 0, 4) !== '%PDF') {
    http_response_code(502);
    die(json_encode(['error' => 'Response is not a valid PDF']));
}

header('Content-Type: application/pdf');
header('Content-Length: ' . strlen($body));
header('Cache-Control: public, max-age=3600');
echo $body;
