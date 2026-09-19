<?php
require_once __DIR__ . '/../includes/db.php';
$db = db_connect();
$users = query_all($db, 'SELECT id, name, email, created_at FROM users ORDER BY name');
?>
<h1>Users</h1>
<table id="users-table">
  <thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
  <tbody>
  <?php foreach ($users as $u): ?>
    <tr>
      <td><?= e($u['name']) ?></td>
      <td><?= e($u['email']) ?></td>
      <td><?= e($u['created_at']) ?></td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>
<input id="user-search" placeholder="Filter users...">
<script src="/js/users.js"></script>
