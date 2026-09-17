<?php
// Only runs from the Hostinger cron job, not from a browser.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}
require __DIR__ . '/config.php';
echo date('c') . ' - processed ' . process_due() . " message(s)\n";
