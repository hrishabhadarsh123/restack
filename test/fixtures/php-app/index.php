<?php
// Legacy PHP entry point
session_start();

require_once __DIR__ . '/includes/db.php';
require_once __DIR__ . '/includes/helpers.php';

$page = $_GET['page'] ?? 'home';

switch ($page) {
    case 'users':
        require __DIR__ . '/pages/users.php';
        break;
    case 'orders':
        require __DIR__ . '/pages/orders.php';
        break;
    default:
        require __DIR__ . '/pages/home.php';
}
