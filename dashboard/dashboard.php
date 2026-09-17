<?php
require __DIR__ . '/config.php';

// Log out automatically after this many seconds without activity
const SESSION_TIMEOUT = 15 * 60;

// Session cookie only lives until the browser is closed, and can't be read by scripts
$isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_name('WADASH'); // own cookie name, separate from any old PHPSESSID
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => $isHttps,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

// Never let the browser or Hostinger's cache/CDN store this page
header('Cache-Control: no-store, no-cache, must-revalidate, private, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
header('X-LiteSpeed-Cache-Control: no-cache');

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

// Reusable fields
$phone   = ['phone' => ['text', 'Phone (91XXXXXXXXXX)']];
$groupId = ['groupId' => ['text', 'Group ID (from "List groups", ends with @g.us)']];
$members = ['participants' => ['list', 'Participant phones (comma separated)']];
$useLast = ['useLastMessage' => ['bool', 'Use last received message', true]];

// key => [section, label, method, path, fields, note]
$FEATURES = [
    'health'         => ['Status', 'Health check (all numbers)', 'GET', '/health', [], ''],
    'client-info'    => ['Status', 'Connected account info', 'GET', '/test/client-info', [], ''],

    'send'           => ['Messaging', 'Send text message', 'POST', '/send', $phone + ['message' => ['textarea', 'Message']], ''],
    'reply'          => ['Messaging', 'Reply to incoming message', 'POST', '/test/reply', $phone + ['message' => ['textarea', 'Reply text']] + $useLast, 'Someone must message the active number first.'],
    'react'          => ['Messaging', 'React to a message', 'POST', '/test/react', $phone + ['emoji' => ['text', 'Emoji', '👍']] + $useLast, 'Someone must message the active number first.'],
    'location'       => ['Messaging', 'Share location', 'POST', '/test/send-location', $phone + [
                            'latitude'    => ['number', 'Latitude', '17.3850'],
                            'longitude'   => ['number', 'Longitude', '78.4867'],
                            'description' => ['text', 'Description', 'Qubitbots office']], ''],
    'poll'           => ['Messaging', 'Create poll', 'POST', '/test/poll', $phone + [
                            'question' => ['text', 'Question'],
                            'options'  => ['list', 'Options (comma separated)', 'Yes, No, Maybe']], ''],

    'send-image'     => ['Media', 'Send image with caption', 'POST', '/send-image', $phone + ['caption' => ['text', 'Caption']], 'Sends sample.jpg from the Docker image.'],
    'send-document'  => ['Media', 'Send document with caption', 'POST', '/send-document', $phone + ['caption' => ['text', 'Caption']], 'Sends sample.docx from the Docker image.'],
    'download-media' => ['Media', 'Download media from last message', 'POST', '/test/download-media', $phone + $useLast, 'Someone must send an image or document to the active number first.'],

    'contact'        => ['Contacts', 'Send contact (/test/contact)', 'POST', '/test/contact', $phone + ['contactPhone' => ['text', 'Contact phone']], ''],
    'contact-card'   => ['Contacts', 'Share contact card', 'POST', '/test/contact-card', $phone + ['contactPhone' => ['text', 'Contact to share']], ''],
    'chat'           => ['Contacts', 'Chat info', 'GET', '/test/chat/{phone}', $phone, ''],
    'profile-pic'    => ['Contacts', 'Profile picture', 'GET', '/test/profile-picture/{phone}', $phone, ''],

    'mute'           => ['Chat controls', 'Mute chat', 'POST', '/test/mute', $phone + ['duration' => ['number', 'Duration in seconds (optional, e.g. 3600)']], ''],
    'unmute'         => ['Chat controls', 'Unmute chat', 'POST', '/test/unmute', $phone, ''],
    'block'          => ['Chat controls', 'Block contact', 'POST', '/test/block', $phone, 'Use a test number only.'],
    'unblock'        => ['Chat controls', 'Unblock contact', 'POST', '/test/unblock', $phone, ''],
    'status'         => ['Chat controls', 'Set About/status text', 'POST', '/test/status', ['status' => ['text', 'About text']], 'Changes the About text of the active number.'],

    'groups'         => ['Groups', 'List groups', 'GET', '/test/groups', [], 'Copy a group ID from here for the forms below.'],
    'create-group'   => ['Groups', 'Create group', 'POST', '/test/create-group', ['name' => ['text', 'Group name']] + $members, ''],
    'group-info'     => ['Groups', 'Group info, members and admins', 'GET', '/test/group-info/{groupId}', $groupId, ''],
    'group-invite'   => ['Groups', 'Get invite link', 'GET', '/test/group-invite/{groupId}', $groupId, ''],
    'join-group'     => ['Groups', 'Join group by invite code', 'POST', '/test/join-group', ['inviteCode' => ['text', 'Invite code (part after chat.whatsapp.com/)']], ''],
    'group-send'     => ['Groups', 'Send message to group', 'POST', '/test/group-send-messages', $groupId + ['message' => ['textarea', 'Message']], ''],
    'group-subject'  => ['Groups', 'Change group name', 'POST', '/test/group-subject', $groupId + ['subject' => ['text', 'New name']], ''],
    'group-desc'     => ['Groups', 'Set group description', 'POST', '/test/group-description', $groupId + ['description' => ['textarea', 'Description']], 'Known whatsapp-web.js bug: expected to fail.'],
    'group-perms'    => ['Groups', 'Group permissions', 'POST', '/test/group-edit-info', $groupId + [
                            'sendMessages' => ['bool', 'Only admins can send messages', false],
                            'editInfo'     => ['bool', 'Only admins can edit group info', false]], ''],
    'group-add'      => ['Groups', 'Add members', 'POST', '/test/group-add', $groupId + $members, ''],
    'group-remove'   => ['Groups', 'Remove members', 'POST', '/test/group-remove', $groupId + $members, ''],
    'group-promote'  => ['Groups', 'Promote to admin', 'POST', '/test/group-promote', $groupId + $members, ''],
    'group-demote'   => ['Groups', 'Demote admin', 'POST', '/test/group-demote', $groupId + $members, ''],
];

$msg    = '';
$result = null;
$active = '';

// ---- Login / logout ----
// Returns the password for a login name ("admin" or a number's name), or null
function password_for($user) {
    if ($user === 'admin') return ADMIN_PASSWORD;
    return ACCOUNT_PASSWORDS[$user] ?? null;
}

if (isset($_POST['login'])) {
    $u  = strtolower(trim((string)($_POST['username'] ?? '')));
    $pw = password_for($u);
    if ($pw !== null && $pw !== '' && hash_equals($pw, (string)($_POST['password'] ?? ''))) {
        session_regenerate_id(true);
        $_SESSION = [
            'ok'   => true,
            'user' => $u,
            'pw'   => hash('sha256', $pw),
            'last' => time(),
        ];
        session_write_close();
        session_start();
    } else {
        sleep(1); // slow down password guessing
        $msg = 'Wrong name or password.';
    }
}
if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    header('Location: dashboard.php');
    exit;
}

// Logged in only if: logged in before, that login's password unchanged since, and not idle too long
$user    = $_SESSION['user'] ?? '';
$userPw  = $user !== '' ? password_for($user) : null;
$logged  = !empty($_SESSION['ok'])
    && $userPw !== null
    && ($_SESSION['pw'] ?? '') === hash('sha256', $userPw)
    && time() - ($_SESSION['last'] ?? 0) < SESSION_TIMEOUT;

if (!$logged && !empty($_SESSION['ok'])) {
    $_SESSION = [];
    $msg = $msg ?: 'Session expired. Please log in again.';
}
if ($logged) {
    $_SESSION['last'] = time();
}

$isAdmin = $logged && $user === 'admin';
// A number's login is locked to that number; admin can switch
$current = $isAdmin ? ($_SESSION['account'] ?? DEFAULT_ACCOUNT) : $user;
$linking = isset($_GET['link']) ? strtolower(preg_replace('/[^a-z0-9_-]/i', '', $_GET['link'])) : '';
if (!$isAdmin && $linking !== $current) $linking = '';

// ---- Account actions ----
if ($logged && !empty($_POST['acct_action'])) {
    $active = 'accounts';
    $id = strtolower(trim($_POST['acct_id'] ?? ''));
    $action = $_POST['acct_action'];
    // Number logins may only restart their own number
    if (!$isAdmin && !($action === 'restart' && $id === $current)) {
        $action = 'denied';
        $msg = 'Only the admin can do that.';
    }
    switch ($action) {
        case 'use':
            $_SESSION['account'] = $current = $id;
            if (!password_for($id)) {
                $msg = 'Active number switched to "' . $id . '". Tip: add a password for it in config.php so its own team can log in.';
                break;
            }
            $msg = 'Active number switched to "' . $id . '".';
            break;
        case 'add':
            $r = api('POST', '/accounts', ['id' => $id]);
            if ($r['ok']) {
                header('Location: dashboard.php?link=' . rawurlencode($id));
                exit;
            }
            $msg = 'Could not add: ' . ($r['data']['error'] ?? $r['raw']);
            break;
        case 'restart':
            $r = api('POST', '/accounts/' . rawurlencode($id) . '/restart');
            $msg = $r['ok'] ? 'Restarting "' . $id . '".' : 'Restart failed: ' . ($r['data']['error'] ?? $r['raw']);
            break;
        case 'logout':
            $r = api('POST', '/accounts/' . rawurlencode($id) . '/logout');
            if ($r['ok']) {
                header('Location: dashboard.php?link=' . rawurlencode($id));
                exit;
            }
            $msg = 'Logout failed: ' . ($r['data']['error'] ?? $r['raw']);
            break;
        case 'delete':
            $r = api('DELETE', '/accounts/' . rawurlencode($id) . '?removeSession=true');
            if ($r['ok'] && $current === $id) {
                $_SESSION['account'] = $current = DEFAULT_ACCOUNT;
            }
            $msg = $r['ok'] ? 'Deleted "' . $id . '".' : 'Delete failed: ' . ($r['data']['error'] ?? $r['raw']);
            break;
    }
}

// ---- Run a feature on the active number ----
if ($logged && isset($_POST['ep'], $FEATURES[$_POST['ep']])) {
    $active = $_POST['ep'];
    [, , $method, $path, $fields] = $FEATURES[$active];
    $body = [];
    foreach ($fields as $name => $def) {
        $raw   = trim((string)($_POST[$name] ?? ''));
        $token = '{' . $name . '}';
        if (strpos($path, $token) !== false) {
            $path = str_replace($token, rawurlencode($raw), $path);
            continue;
        }
        switch ($def[0]) {
            case 'bool':   $body[$name] = !empty($_POST[$name]); break;
            case 'list':   $body[$name] = array_values(array_filter(array_map('trim', explode(',', $raw)), 'strlen')); break;
            case 'number': if ($raw !== '') $body[$name] = is_numeric($raw) ? $raw + 0 : $raw; break;
            default:       $body[$name] = $raw;
        }
    }
    $result = api($method, $path, $method === 'GET' ? null : $body, $current);
    $result['request'] = '[' . $current . '] ' . $method . ' ' . $path . ($method === 'GET' ? '' : '  ' . json_encode($body, JSON_UNESCAPED_UNICODE));
}

// ---- Scheduled messages ----
if ($logged && !empty($_POST['action'])) {
    $active = 'schedule';
    $items  = load_schedule();
    switch ($_POST['action']) {
        case 'schedule':
            $p = preg_replace('/\D/', '', $_POST['phone'] ?? '');
            $m = trim($_POST['message'] ?? '');
            $t = strtotime($_POST['when'] ?? '');
            $a = $isAdmin ? strtolower(trim($_POST['account'] ?? $current)) : $current;
            if (strlen($p) < 11 || $m === '' || !$t) { $msg = 'Fill in phone, message and time.'; break; }
            $items[] = ['id' => bin2hex(random_bytes(6)), 'account' => $a, 'phone' => $p, 'message' => $m, 'send_at' => $t, 'status' => 'pending'];
            save_schedule($items);
            $msg = 'Scheduled from "' . $a . '" for ' . date('d M Y, h:i A', $t) . ' IST.';
            break;
        case 'cancel':
            $id = $_POST['id'] ?? '';
            save_schedule(array_filter($items, fn($i) =>
                $i['id'] !== $id || (!$isAdmin && ($i['account'] ?? DEFAULT_ACCOUNT) !== $current)));
            $msg = 'Removed.';
            break;
        case 'run_due':
            if (!$isAdmin) { $msg = 'Only the admin can do that.'; break; }
            $msg = process_due() . ' due message(s) processed.';
            break;
    }
}

// ---- Account list (for the header, dropdowns and QR panel) ----
$accountList = [];
$apiDown = '';
$linkInfo = null;
if ($logged) {
    $r = api('GET', '/accounts');
    if ($r['ok']) {
        $accountList = $r['data']['accounts'] ?? [];
        if (!$isAdmin) {
            $accountList = array_values(array_filter($accountList, fn($a) => $a['id'] === $current));
        }
    } else {
        $apiDown = $r['data']['error'] ?? $r['raw'];
    }
    if ($linking !== '') {
        $q = api('GET', '/accounts/' . rawurlencode($linking) . '/qr');
        $linkInfo = $q['ok'] ? $q['data'] : ['state' => 'unknown', 'error' => $q['data']['error'] ?? $q['raw']];
    }
}
$currentState = 'unknown';
foreach ($accountList as $a) {
    if ($a['id'] === $current) $currentState = $a['state'];
}

function field($name, $def, $isActive) {
    [$type, $label] = $def;
    $val = $isActive && isset($_POST[$name]) ? $_POST[$name] : ($def[2] ?? '');
    if ($type === 'bool') {
        $checked = $isActive ? !empty($_POST[$name]) : !empty($def[2]);
        return '<label class="chk"><input type="checkbox" name="' . h($name) . '" value="1"' . ($checked ? ' checked' : '') . '> ' . h($label) . '</label>';
    }
    $html = '<label>' . h($label) . '</label>';
    if ($type === 'textarea') return $html . '<textarea name="' . h($name) . '">' . h($val) . '</textarea>';
    return $html . '<input name="' . h($name) . '" value="' . h($val) . '">';
}

function state_badge($state) {
    $cls = $state === 'ready' ? 'ok' : (in_array($state, ['qr', 'initializing', 'authenticated'], true) ? 'wait' : 'bad');
    return '<span class="badge ' . $cls . '">' . h($state) . '</span>';
}

$sections = [];
foreach ($FEATURES as $k => $f) $sections[$f[0]][$k] = $f;

// Keep refreshing while a number is being linked
$autoRefresh = $logged && $linkInfo && ($linkInfo['state'] ?? '') !== 'ready';
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php if ($autoRefresh): ?><meta http-equiv="refresh" content="8"><?php endif; ?>
<title>WhatsApp API Test Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f0f2f5; margin: 0; padding: 16px; color: #1c1e21; }
  .wrap { max-width: 800px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; color: #075e54; margin: 8px 0; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #555; text-transform: uppercase; letter-spacing: .04em; }
  details, .panel { background: #fff; border-radius: 10px; margin: 8px 0; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .panel { padding: 14px 16px; }
  summary { padding: 12px 16px; cursor: pointer; font-weight: 600; }
  summary small { color: #888; font-weight: 400; margin-left: 6px; }
  .body { padding: 0 16px 16px; }
  label { display: block; font-size: 13px; margin-top: 10px; }
  label.chk { display: flex; gap: 6px; align-items: center; }
  input:not([type=checkbox]), textarea, select { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; }
  textarea { min-height: 70px; }
  button { margin-top: 12px; padding: 8px 16px; background: #25d366; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }
  button.grey { background: #888; } button.red { background: #d9534f; }
  button.small { margin: 2px; padding: 5px 10px; font-size: 12px; }
  .note { font-size: 12px; color: #a15c00; margin: 4px 0 0; }
  .result { margin-top: 12px; border-radius: 6px; padding: 10px; font-size: 13px; }
  .ok { background: #e7f5ee; } .bad { background: #fdecea; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; margin: 6px 0 0; }
  .msg { background: #fff3cd; padding: 10px; border-radius: 8px; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  td, th { border-bottom: 1px solid #eee; padding: 6px; text-align: left; vertical-align: top; }
  td form { display: inline; }
  code { background: #eee; padding: 2px 4px; border-radius: 4px; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: #d4f5e2; color: #0a7a3e; } .badge.wait { background: #fff1c2; color: #8a6100; } .badge.bad { background: #fbd9d6; color: #a12a1f; }
  .active-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .active-bar select { width: auto; }
  .active-bar button { margin-top: 0; }
  .qr { text-align: center; }
  .qr img { width: 260px; max-width: 100%; border: 8px solid #fff; box-shadow: 0 1px 6px rgba(0,0,0,.15); }
  .login { max-width: 360px; margin: 60px auto; background: #fff; padding: 24px; border-radius: 12px; }
</style>
</head>
<body>
<div class="wrap">
<?php if (!$logged): ?>
  <div class="login">
    <h1>WhatsApp API Test Dashboard</h1>
    <?php if ($msg): ?><div class="msg"><?= h($msg) ?></div><?php endif; ?>
    <form method="post">
      <label>Number name (or <code>admin</code>)</label>
      <input name="username" required autofocus autocomplete="username" placeholder="e.g. sales">
      <label>Password</label>
      <input type="password" name="password" required autocomplete="current-password">
      <button name="login" value="1">Log in</button>
    </form>
  </div>
<?php else: ?>
  <header>
    <h1>WhatsApp API Test Dashboard</h1>
    <span>Logged in as <b><?= h($user) ?></b> · <a href="?logout=1">Log out</a></span>
  </header>

  <div class="panel">
    <?php if ($isAdmin): ?>
    <form method="post" class="active-bar" autocomplete="off">
      <input type="hidden" name="acct_action" value="use">
      <strong>Active number:</strong>
      <select name="acct_id" autocomplete="off">
        <?php foreach ($accountList as $a): ?>
          <option value="<?= h($a['id']) ?>" <?= $a['id'] === $current ? 'selected' : '' ?>>
            <?= h($a['id']) ?><?= $a['phone'] ? ' (' . h($a['phone']) . ')' : '' ?> – <?= h($a['state']) ?>
          </option>
        <?php endforeach; ?>
        <?php if (!$accountList): ?><option value="<?= h($current) ?>"><?= h($current) ?></option><?php endif; ?>
      </select>
      <button class="small">Switch</button>
      <?= state_badge($currentState) ?>
    </form>
    <?php else: ?>
    <div class="active-bar">
      <strong>Your number:</strong>
      <?= h($current) ?><?php foreach ($accountList as $a) { if ($a['phone']) echo ' (' . h($a['phone']) . ')'; } ?>
      <?= state_badge($currentState) ?>
    </div>
    <?php endif; ?>
    <?php if ($apiDown): ?><p class="note">API not reachable: <?= h($apiDown) ?></p><?php endif; ?>
  </div>

  <?php if ($msg): ?><div class="msg"><?= h($msg) ?></div><?php endif; ?>

  <?php if ($linkInfo): ?>
    <div class="panel qr">
      <h2 style="margin-top:0">Link number "<?= h($linking) ?>"</h2>
      <?php if (($linkInfo['state'] ?? '') === 'ready'): ?>
        <p>✅ Linked and ready.</p>
        <form method="post"><input type="hidden" name="acct_action" value="use"><input type="hidden" name="acct_id" value="<?= h($linking) ?>"><button>Use this number</button></form>
      <?php elseif (!empty($linkInfo['qrImage'])): ?>
        <p>On the phone for this number: WhatsApp → ⋮ → <b>Linked devices</b> → <b>Link a device</b>, then scan:</p>
        <img src="<?= h($linkInfo['qrImage']) ?>" alt="WhatsApp QR code">
        <p class="note">The QR code changes every ~20 seconds; this page refreshes automatically.</p>
      <?php else: ?>
        <p>State: <?= state_badge($linkInfo['state'] ?? 'unknown') ?> – waiting for the QR code… (refreshing)</p>
        <?php if (!empty($linkInfo['error'])): ?><p class="note"><?= h($linkInfo['error']) ?></p><?php endif; ?>
      <?php endif; ?>
      <p><a href="dashboard.php">Close</a></p>
    </div>
  <?php endif; ?>

  <h2>Numbers</h2>
  <details <?= $active === 'accounts' ? 'open' : '' ?>>
    <summary><?= $isAdmin ? 'Manage WhatsApp numbers' : 'Your WhatsApp number' ?><small><?= $isAdmin ? count($accountList) . ' linked / starting' : '' ?></small></summary>
    <div class="body">
      <table>
        <tr><th>Name</th><th>Phone</th><th>State</th><th>Actions</th></tr>
        <?php foreach ($accountList as $a): $aid = h($a['id']); ?>
          <tr>
            <td><?= $aid ?><?= $a['id'] === $current ? ' <b>(active)</b>' : '' ?></td>
            <td><?= h($a['phone'] ?? '–') ?></td>
            <td><?= state_badge($a['state']) ?></td>
            <td>
              <?php if ($isAdmin): ?><form method="post"><input type="hidden" name="acct_id" value="<?= $aid ?>"><button class="small" name="acct_action" value="use">Use</button></form><?php endif; ?>
              <?php if ($a['state'] !== 'ready'): ?><a href="?link=<?= rawurlencode($a['id']) ?>"><button class="small" type="button">Show QR</button></a><?php endif; ?>
              <form method="post"><input type="hidden" name="acct_id" value="<?= $aid ?>"><button class="small grey" name="acct_action" value="restart">Restart</button></form>
              <?php if ($isAdmin): ?>
              <form method="post" onsubmit="return confirm('Unlink <?= $aid ?> from WhatsApp? A new QR scan will be needed.')"><input type="hidden" name="acct_id" value="<?= $aid ?>"><button class="small grey" name="acct_action" value="logout">Log out</button></form>
              <?php if ($a['id'] !== DEFAULT_ACCOUNT): ?>
                <form method="post" onsubmit="return confirm('Delete <?= $aid ?> and its saved login?')"><input type="hidden" name="acct_id" value="<?= $aid ?>"><button class="small red" name="acct_action" value="delete">Delete</button></form>
              <?php endif; ?>
              <?php endif; ?>
            </td>
          </tr>
        <?php endforeach; ?>
      </table>

      <?php if ($isAdmin): ?>
      <p class="note">Numbers without a password in <code>config.php</code> can only be used by the admin.</p>
      <form method="post">
        <input type="hidden" name="acct_action" value="add">
        <label>Link a new number – short name (lowercase letters, numbers, - or _), e.g. <code>support</code></label>
        <input name="acct_id" pattern="[a-z0-9_-]{1,32}" required>
        <button>Add number &amp; show QR</button>
      </form>
      <?php endif; ?>
    </div>
  </details>

  <?php foreach ($sections as $section => $items): ?>
    <h2><?= h($section) ?> <small style="text-transform:none">– using “<?= h($current) ?>”</small></h2>
    <?php foreach ($items as $key => [$sec, $label, $method, $path, $fields, $note]): ?>
      <details <?= $active === $key ? 'open' : '' ?>>
        <summary><?= h($label) ?><small><?= h($method . ' ' . $path) ?></small></summary>
        <div class="body">
          <?php if ($note): ?><p class="note"><?= h($note) ?></p><?php endif; ?>
          <form method="post">
            <input type="hidden" name="ep" value="<?= h($key) ?>">
            <?php foreach ($fields as $name => $def) echo field($name, $def, $active === $key); ?>
            <button>Run</button>
          </form>
          <?php if ($result && $active === $key):
              $out = $result['data'] !== null
                  ? json_encode($result['data'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
                  : $result['raw'];
              if (strlen($out) > 6000) $out = substr($out, 0, 6000) . "\n… (truncated)";
          ?>
            <div class="result <?= $result['ok'] ? 'ok' : 'bad' ?>">
              <b><?= $result['ok'] ? 'Success' : 'Failed' ?></b> (HTTP <?= (int)$result['code'] ?>)
              <pre><?= h($result['request']) ?></pre>
              <pre><?= h($out) ?></pre>
            </div>
          <?php endif; ?>
        </div>
      </details>
    <?php endforeach; ?>
  <?php endforeach; ?>

  <h2>Scheduling</h2>
  <details <?= $active === 'schedule' ? 'open' : '' ?>>
    <summary>Scheduled messages<small>stored on Hostinger, sent by cron</small></summary>
    <div class="body">
      <form method="post">
        <input type="hidden" name="action" value="schedule">
        <?php if ($isAdmin): ?>
        <label>Send from</label>
        <select name="account">
          <?php foreach ($accountList as $a): ?>
            <option value="<?= h($a['id']) ?>" <?= $a['id'] === $current ? 'selected' : '' ?>><?= h($a['id']) ?><?= $a['phone'] ? ' (' . h($a['phone']) . ')' : '' ?></option>
          <?php endforeach; ?>
          <?php if (!$accountList): ?><option value="<?= h($current) ?>"><?= h($current) ?></option><?php endif; ?>
        </select>
        <?php else: ?>
        <p class="note">Messages are sent from <b><?= h($current) ?></b>.</p>
        <?php endif; ?>
        <label>Phone (91XXXXXXXXXX)</label><input name="phone" required>
        <label>Message</label><textarea name="message" required></textarea>
        <label>Send at (IST)</label><input type="datetime-local" name="when" required>
        <button>Schedule</button>
      </form>
      <?php if ($isAdmin): ?>
      <form method="post">
        <input type="hidden" name="action" value="run_due">
        <button class="grey">Send due messages now</button>
      </form>
      <p class="note">Cron command: <code>/usr/bin/php <?= h(__DIR__) ?>/cron.php</code></p>
      <?php endif; ?>
      <table>
        <tr><th>When (IST)</th><th>From</th><th>To</th><th>Message</th><th>Status</th><th></th></tr>
        <?php foreach (array_reverse(load_schedule()) as $it):
            if (!$isAdmin && ($it['account'] ?? DEFAULT_ACCOUNT) !== $current) continue; ?>
          <tr>
            <td><?= h(date('d M, h:i A', $it['send_at'])) ?></td>
            <td><?= h($it['account'] ?? DEFAULT_ACCOUNT) ?></td>
            <td><?= h($it['phone']) ?></td>
            <td><?= h($it['message']) ?></td>
            <td><?= h($it['status']) ?><?= !empty($it['result']) ? '<pre>' . h($it['result']) . '</pre>' : '' ?></td>
            <td>
              <form method="post">
                <input type="hidden" name="action" value="cancel">
                <input type="hidden" name="id" value="<?= h($it['id']) ?>">
                <button class="grey small"><?= $it['status'] === 'pending' ? 'Cancel' : 'Remove' ?></button>
              </form>
            </td>
          </tr>
        <?php endforeach; ?>
      </table>
    </div>
  </details>
<?php endif; ?>
</div>
</body>
</html>
