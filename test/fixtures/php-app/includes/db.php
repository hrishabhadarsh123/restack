<?php
function db_connect(): PDO {
    $host = getenv('DB_HOST') ?: 'localhost';
    $name = getenv('DB_NAME') ?: 'shop';
    $dsn = "mysql:host=$host;dbname=$name;charset=utf8mb4";
    return new PDO($dsn, getenv('DB_USER'), getenv('DB_PASS'), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
}

function query_all(PDO $db, string $sql, array $params = []): array {
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}
