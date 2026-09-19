<?php
require_once __DIR__ . '/../includes/db.php';
header('Content-Type: application/json');

$q = $_GET['q'] ?? '';
$db = db_connect();
$rows = query_all($db, 'SELECT id, name, email FROM users WHERE name LIKE ?', ['%' . $q . '%']);
echo json_encode(['results' => $rows]);
