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
    header('Vary: Origin');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') return;
    $allowedOrigin = trim((string) getenv('SQ_PROXY_ALLOWED_ORIGIN'));
    if ($allowedOrigin === '' || !hash_equals($allowedOrigin, $origin)) failRequest(403, 'Origin not allowed');
    header('Access-Control-Allow-Origin: ' . $allowedOrigin);
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Max-Age: 600');
}

function queryString(string $name): string {
    $value = $_GET[$name] ?? '';
    if (!is_string($value)) failRequest(400, 'Query parameter ' . $name . ' must be a string');
    return $value;
}

function integerSetting(string $name, int $default, int $minimum, int $maximum): int {
    $raw = getenv($name);
    if ($raw === false || $raw === '') return $default;
    if (!preg_match('/^[0-9]+$/D', $raw) || strlen($raw) > 12) failRequest(503, 'Invalid proxy setting: ' . $name);
    return max($minimum, min($maximum, (int) $raw));
}

function enforceToken(): void {
    $expected = (string) getenv('SQ_PROXY_TOKEN');
    if ($expected === '') return;
    $provided = queryString('token');
    if ($provided === '' || !hash_equals($expected, $provided)) failRequest(401, 'Unauthorized');
}

function enforceRateLimit(): void {
    $limit = integerSetting('SQ_PROXY_RATE_LIMIT', 30, 1, 300);
    $client = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $bucket = gmdate('YmdHi');
    $directory = sys_get_temp_dir() . '/sq-proxy-rate-' . substr(hash('sha256', __FILE__), 0, 16);
    if (!is_dir($directory) && !@mkdir($directory, 0700) && !is_dir($directory)) failRequest(503, 'Rate limiter unavailable');
    if (is_link($directory) || (fileperms($directory) & 0077) !== 0) failRequest(503, 'Unsafe rate limiter directory');
    // Reuse a single file per client instead of leaking one file per client per minute.
    $path = $directory . '/' . hash('sha256', $client) . '.count';
    if (is_link($path)) failRequest(503, 'Unsafe rate limiter file');
    $handle = @fopen($path, 'c+');
    if ($handle === false) failRequest(503, 'Rate limiter unavailable');
    try {
        if (!flock($handle, LOCK_EX)) failRequest(503, 'Rate limiter unavailable');
        $raw = stream_get_contents($handle);
        $parts = explode('|', $raw === false ? '' : trim($raw));
        $count = ($parts[0] ?? '') === $bucket ? (int) ($parts[1] ?? 0) : 0;
        if ($count >= $limit) {
            header('Retry-After: ' . (60 - (int) gmdate('s')));
            failRequest(429, 'Rate limit exceeded');
        }
        rewind($handle);
        $next = $bucket . '|' . (string) ($count + 1);
        if (!ftruncate($handle, 0) || fwrite($handle, $next) !== strlen($next) || !fflush($handle)) failRequest(503, 'Rate limiter unavailable');
        flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

/** PHP's private/reserved filters alone allow multicast, documentation and shared-space addresses. */
function isPublicAddress(string $ip): bool {
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) return false;
    $packed = inet_pton($ip);
    if ($packed === false) return false;
    $ranges = strlen($packed) === 4 ? [
        '0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '192.0.2.0/24',
        '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4',
    ] : ['::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', 'ff00::/8'];
    foreach ($ranges as $range) {
        [$network, $prefix] = explode('/', $range);
        $networkBytes = inet_pton($network);
        $bits = (int) $prefix;
        $whole = intdiv($bits, 8);
        $remainder = $bits % 8;
        if (substr($packed, 0, $whole) !== substr($networkBytes, 0, $whole)) continue;
        if ($remainder === 0 || (ord($packed[$whole]) & (0xff << (8 - $remainder))) === (ord($networkBytes[$whole]) & (0xff << (8 - $remainder)))) return false;
    }
    return true;
}

/** Follow CDN aliases without changing the requested TLS host or weakening IP checks. */
function resolveAddresses(string $host, callable $lookup, array $path = []): array {
    $host = strtolower(rtrim($host, '.'));
    if (isset($path[$host]) || count($path) >= 6) failRequest(502, 'DNS alias loop or excessive depth');
    if (strlen($host) > 253 || !preg_match('/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/D', $host)) failRequest(502, 'Invalid DNS alias');
    $path[$host] = true;
    $records = $lookup($host);
    if (!is_array($records) || !$records) failRequest(502, 'DNS resolution failed');
    $ips = [];
    $aliases = [];
    foreach ($records as $record) {
        if (isset($record['ip'])) $ips[] = (string) $record['ip'];
        if (isset($record['ipv6'])) $ips[] = (string) $record['ipv6'];
        if (isset($record['target']) && strtoupper((string) ($record['type'] ?? '')) === 'CNAME') $aliases[] = (string) $record['target'];
    }
    if (!$ips) foreach (array_unique($aliases) as $alias) $ips = array_merge($ips, resolveAddresses($alias, $lookup, $path));
    if (!$ips) failRequest(502, 'DNS returned no address');
    foreach ($ips as $ip) if (!isPublicAddress($ip)) failRequest(403, 'Target resolves to a non-public address');
    return array_values(array_unique($ips));
}

/** @return array{url:string,host:string,port:int,ip:string,ips:array<string>} */
function validateTarget(string $url, ?callable $lookup = null): array {
    if (strlen($url) > 2048) failRequest(400, 'URL too long');
    if (preg_match('/[\x00-\x20\x7f]/', $url)) failRequest(400, 'URL contains whitespace or control characters');
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

    $lookup ??= static fn (string $hostname): array|false => @dns_get_record($hostname, DNS_A | DNS_AAAA | DNS_CNAME);
    $ips = resolveAddresses($host, $lookup);
    // Canonical host must match CURLOPT_RESOLVE, including trailing-dot inputs.
    $url = 'https://' . $host . ($parts['path'] ?? '/') . (isset($parts['query']) ? '?' . $parts['query'] : '');
    return ['url' => $url, 'host' => $host, 'port' => $port, 'ip' => $ips[0], 'ips' => array_values(array_unique($ips))];
}

function resolveRedirect(string $baseUrl, string $location): string {
    $location = trim($location);
    if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $location)) return $location; // validateTarget rejects non-HTTPS schemes
    $base = parse_url($baseUrl);
    if (!is_array($base) || !isset($base['host'])) failRequest(502, 'Invalid redirect base');
    if (str_starts_with($location, '//')) return 'https:' . $location;
    $root = 'https://' . $base['host'];
    if (str_starts_with($location, '?')) return $root . ($base['path'] ?? '/') . $location;
    if (str_starts_with($location, '#')) return preg_replace('/#.*$/', '', $baseUrl) . $location;
    if (str_starts_with($location, '/')) return $root . $location;
    $path = (string) ($base['path'] ?? '/');
    $directory = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
    return $root . $directory . $location;
}

/** @return array{status:int,body:string,location:string,contentType:string} */
function downloadOnce(array $target, int $maxBytes, int $timeoutMs = 25000): array {
    if (!extension_loaded('curl')) failRequest(503, 'PHP cURL extension is required');
    $body = '';
    $location = '';
    $contentType = '';
    $tooLarge = false;
    $ch = curl_init($target['url']);
    if ($ch === false) failRequest(500, 'Unable to initialize cURL');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROXY => '', // DNS pinning must not be delegated to an environment proxy.
        CURLOPT_CONNECTTIMEOUT_MS => min(10000, $timeoutMs),
        CURLOPT_TIMEOUT_MS => $timeoutMs,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'AI-SQ-Grader-PDF-Proxy/2.0',
        CURLOPT_HTTPHEADER => ['Accept: application/pdf,*/*;q=0.5'],
        CURLOPT_RESOLVE => [sprintf('%s:%d:%s', $target['host'], $target['port'], implode(',', array_map(static fn (string $ip): string => str_contains($ip, ':') ? '[' . $ip . ']' : $ip, $target['ips'] ?? [$target['ip']])))],
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

function runProxy(): void {
    configureCors();
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') failRequest(405, 'Method not allowed');
    enforceToken();
    enforceRateLimit();

    $url = queryString('url');
    if ($url === '') failRequest(400, 'Missing url parameter');
    $maxBytes = integerSetting('SQ_PROXY_MAX_BYTES', 25 * 1024 * 1024, 1024 * 1024, 50 * 1024 * 1024);
    $deadline = microtime(true) + 25;

    for ($redirects = 0; $redirects <= 3; $redirects++) {
        $target = validateTarget($url);
        $remainingMs = (int) floor(($deadline - microtime(true)) * 1000);
        if ($remainingMs <= 0) failRequest(504, 'PDF download deadline exceeded');
        $response = downloadOnce($target, $maxBytes, $remainingMs);
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
}

// Allow CLI tests and deployment wrappers to load helpers without starting a request.
if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) runProxy();
