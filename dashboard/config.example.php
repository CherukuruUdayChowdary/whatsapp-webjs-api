<?php
// ---- Settings (keep this file private) ----
const API_URL         = 'https://YOUR-TUNNEL.trycloudflare.com'; // no trailing slash
const API_KEY         = 'YOUR_API_KEY';
// Admin login: sees and manages every number (log in with name "admin")
const ADMIN_PASSWORD  = 'ChangeThisAdminPassword';

// One password per number (log in with the number's name).
// A number without an entry here can only be used by the admin.
const ACCOUNT_PASSWORDS = [
    'default' => 'ChangeThisDefaultPassword',
    'sales'   => 'ChangeThisSalesPassword',
];
const DEFAULT_ACCOUNT = 'default';
const SCHEDULE_FILE   = __DIR__ . '/data/schedule.json';

date_default_timezone_set('Asia/Kolkata');

// $account: which WhatsApp number to use (null = API default)
function api($method, $path, $body = null, $account = null) {
    $headers = ['Content-Type: application/json', 'x-api-key: ' . API_KEY];
    if ($account !== null && $account !== '') {
        $headers[] = 'x-account: ' . $account;
    }

    $ch = curl_init(API_URL . $path);
    $opts = [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_HTTPHEADER     => $headers,
    ];
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = json_encode($body);
    }
    curl_setopt_array($ch, $opts);
    $raw  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false) {
        return ['ok' => false, 'code' => 0, 'raw' => 'Cannot reach the API (laptop/tunnel off?): ' . $err, 'data' => null];
    }
    $data = json_decode($raw, true);
    return ['ok' => !empty($data['success']), 'code' => $code, 'raw' => $raw, 'data' => $data];
}

function load_schedule() {
    if (!is_file(SCHEDULE_FILE)) return [];
    $items = json_decode(file_get_contents(SCHEDULE_FILE), true);
    return is_array($items) ? $items : [];
}

function save_schedule($items) {
    $dir = dirname(SCHEDULE_FILE);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    file_put_contents(SCHEDULE_FILE, json_encode(array_values($items), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

// Sends every pending message whose time has come, from the account it was scheduled on.
// Unreachable API / account not ready (HTTP 0 or 503) => stays pending and is retried next run.
function process_due() {
    $items = load_schedule();
    $done  = 0;
    foreach ($items as &$it) {
        if ($it['status'] !== 'pending' || $it['send_at'] > time()) continue;
        $acct = $it['account'] ?? DEFAULT_ACCOUNT;
        $r = api('POST', '/send', ['phone' => $it['phone'], 'message' => $it['message']], $acct);
        if ($r['code'] === 0 || $r['code'] === 503) continue;
        $it['status']  = $r['ok'] ? 'sent' : 'failed';
        $it['result']  = substr($r['raw'], 0, 300);
        $it['done_at'] = time();
        $done++;
    }
    unset($it);
    save_schedule($items);
    return $done;
}
