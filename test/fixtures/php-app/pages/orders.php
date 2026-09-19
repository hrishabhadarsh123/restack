<?php
require_once __DIR__ . '/../includes/db.php';
$db = db_connect();
$orders = query_all($db, 'SELECT id, user_id, total, status FROM orders WHERE status = "open"');
?>
<h1>Open Orders</h1>
<ul class="orders">
<?php foreach ($orders as $o): ?>
  <li data-id="<?= (int) $o['id'] ?>">
    Order #<?= (int) $o['id'] ?> — <?= format_money((float) $o['total']) ?> (<?= e($o['status']) ?>)
  </li>
<?php endforeach; ?>
</ul>
