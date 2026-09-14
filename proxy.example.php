<?php
declare(strict_types=1);

/**
 * Hardened optional PDF proxy.
 * Environment variables:
 *   SQ_PROXY_ALLOWED_ORIGIN  Exact web-app origin allowed by CORS (recommended).
 *   SQ_PROXY_TOKEN           Optional shared token, supplied as ?token=...&url=...
 *   SQ_PROXY_RATE_LIMIT      Requests per client IP per minute (default 30).
 *   SQ_PROXY_MAX_BYTES       Maximum PDF bytes (default 25 MiB, hard max 50 MiB).
 */

const ALLOWED_DOMAINS = [
    'filestore.aqa.org.uk',
    'oxfordaqa.com',
    'bestexamhelp.com',
    'gceguide.com',
    'mmerevise.co.uk',
    'pastpapers.co',
];

function failRequest(int $status, string $message): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function configureCors(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') return;
    $allowedOrigin = trim((string) getenv('SQ_PROXY_ALLOWED_ORIGIN'));
    if ($allowedOrigin === '' || !hash_equals($allowedOrigin, $origin)) failRequest(403, 'Origin not allowed');
    header('Access-Control-Allow-Origin: ' . $allowedOrigin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Max-Age: 600');
}

function enforceToken(): void {
    $expected = (string) getenv('SQ_PROXY_TOKEN');
    if ($expected === '') return;
    $provided = (string) ($_GET['token'] ?? '');
    if ($provided === '' || !hash_equals($expected, $provided)) failRequest(401, 'Unauthorized');
}

function enforceRateLimit(): void {
    $limit = max(1, min(300, (int) (getenv('SQ_PROXY_RATE_LIMIT') ?: 30)));
    $client = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $bucket = gmdate('YmdHi');
    $path = sys_get_temp_dir() . '/sq-proxy-' . hash('sha256', $client . '|' . $bucket) . '.count';
    $handle = @fopen($path, 'c+');
    if ($handle === false) failRequest(503, 'Rate limiter unavailable');
    try {
        if (!flock($handle, LOCK_EX)) failRequest(503, 'Rate limiter unavailable');
        $raw = stream_get_contents($handle);
        $count = (int) ($raw === false ? 0 : trim($raw));
        if ($count >= $limit) {
            header('Retry-After: 60');
            failRequest(429, 'Rate limit exceeded');
        }
        rewind($handle);
        ftruncate($handle, 0);
        fwrite($handle, (string) ($count + 1));
        fflush($handle);
        flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

/** @return array{url:string,host:string,port:int,ip:string} */
function validateTarget(string $url): array {
    if (strlen($url) > 2048) failRequest(400, 'URL too long');
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower((string) ($parts['scheme'] ?? '')) !== 'https') failRequest(400, 'Only HTTPS URLs are allowed');
    if (isset($parts['user']) || isset($parts['pass'])) failRequest(400, 'URL credentials are not allowed');
    $port = (int) ($parts['port'] ?? 443);
    if ($port !== 443) failRequest(400, 'Only HTTPS port 443 is allowed');
    $host = strtolower(rtrim((string) ($parts['host'] ?? ''), '.'));
    $allowed = false;
    foreach (ALLOWED_DOMAINS as $domain) {
        if ($host === $domain || str_ends_with($host, '.' . $domain)) { $allowed = true; break; }
    }
    if (!$allowed) failRequest(403, 'Domain not allowed');

    $records = @dns_get_record($host, DNS_A | DNS_AAAA);
    if (!is_array($records) || count($records) === 0) failRequest(502, 'DNS resolution failed');
    $ips = [];
    foreach ($records as $record) {
        $ip = $record['ip'] ?? $record['ipv6'] ?? null;
        if ($ip !== null) $ips[] = (string) $ip;
    }
    if (count($ips) === 0) failRequest(502, 'DNS returned no address');
    foreach ($ips as $ip) {
        $public = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        if ($public === false) failRequest(403, 'Target resolves to a non-public address');
    }
    return ['url' => $url, 'host' => $host, 'port' => $port, 'ip' => $ips[0]];
}

function resolveRedirect(string $baseUrl, string $location): string {
    $location = trim($location);
    if (preg_match('#^https://#i', $location)) return $location;
    $base = parse_url($baseUrl);
    if (!is_array($base) || !isset($base['host'])) failRequest(502, 'Invalid redirect base');
    if (str_starts_with($location, '//')) return 'https:' . $location;
    $root = 'https://' . $base['host'];
    if (str_starts_with($location, '/')) return $root . $location;
    $path = (string) ($base['path'] ?? '/');
    $directory = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
    return $root . $directory . $location;
}

/** @return array{status:int,body:string,location:string,contentType:string} */
function downloadOnce(array $target, int $maxBytes): array {
    $body = '';
    $location = '';
    $contentType = '';
    $tooLarge = false;
    $ch = curl_init($target['url']);
    if ($ch === false) failRequest(500, 'Unable to initialize cURL');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 35,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'AI-SQ-Grader-PDF-Proxy/2.0',
        CURLOPT_HTTPHEADER => ['Accept: application/pdf,*/*;q=0.5'],
        CURLOPT_RESOLVE => [sprintf('%s:%d:%s', $target['host'], $target['port'], $target['ip'])],
        CURLOPT_HEADERFUNCTION => static function ($curl, string $header) use (&$location, &$contentType): int {
            $length = strlen($header);
            if (stripos($header, 'Location:') === 0) $location = trim(substr($header, 9));
            if (stripos($header, 'Content-Type:') === 0) $contentType = trim(substr($header, 13));
            return $length;
        },
        CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body, &$tooLarge, $maxBytes): int {
            if (strlen($body) + strlen($chunk) > $maxBytes) { $tooLarge = true; return 0; }
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($tooLarge) failRequest(413, 'PDF exceeds size limit');
    if ($ok === false) failRequest(502, 'Upstream request failed: ' . $error);
    return ['status' => $status, 'body' => $body, 'location' => $location, 'contentType' => $contentType];
}

configureCors();
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') failRequest(405, 'Method not allowed');
enforceToken();
enforceRateLimit();

$url = (string) ($_GET['url'] ?? '');
if ($url === '') failRequest(400, 'Missing url parameter');
$maxBytes = max(1024 * 1024, min(50 * 1024 * 1024, (int) (getenv('SQ_PROXY_MAX_BYTES') ?: 25 * 1024 * 1024)));

for ($redirects = 0; $redirects <= 3; $redirects++) {
    $target = validateTarget($url);
    $response = downloadOnce($target, $maxBytes);
    if ($response['status'] >= 300 && $response['status'] < 400) {
        if ($response['location'] === '' || $redirects === 3) failRequest(502, 'Invalid or excessive redirect');
        $url = resolveRedirect($url, $response['location']);
        continue;
    }
    if ($response['status'] !== 200) failRequest(502, 'Upstream returned HTTP ' . $response['status']);
    if (!str_starts_with($response['body'], '%PDF')) failRequest(502, 'Response is not a valid PDF');
    header('Content-Type: application/pdf');
    header('Content-Length: ' . strlen($response['body']));
    header('Cache-Control: private, max-age=3600');
    header('X-Content-Type-Options: nosniff');
    echo $response['body'];
    exit;
}

failRequest(502, 'Download failed');
