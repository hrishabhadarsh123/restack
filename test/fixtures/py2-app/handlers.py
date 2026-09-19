# -*- coding: utf-8 -*-
"""HTML rendering helpers (Python 2)."""
import cgi


def render_inventory(items):
    rows = []
    for it in items:
        rows.append('<tr><td>%s</td><td>%d</td><td>%.2f</td></tr>' %
                    (cgi.escape(it['name']), it['qty'], it['price']))
    return ('<h1>Inventory</h1>'
            '<table><tr><th>Name</th><th>Qty</th><th>Price</th></tr>%s</table>'
            % ''.join(rows))


def render_health():
    return 'ok'
