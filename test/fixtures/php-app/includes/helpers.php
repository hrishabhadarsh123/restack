<?php
function e(?string $value): string {
    return htmlspecialchars($value ?? '', ENT_QUOTES, 'UTF-8');
}

function format_money(float $n): string {
    return '$' . number_format($n, 2);
}
