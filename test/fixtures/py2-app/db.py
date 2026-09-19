# -*- coding: utf-8 -*-
"""Tiny sqlite helper (Python 2)."""
import sqlite3


def init(path):
    global _conn
    _conn = sqlite3.connect(path)
    _conn.row_factory = sqlite3.Row


def all_items():
    cur = _conn.execute('SELECT id, name, qty, price FROM items ORDER BY name')
    return [dict(r) for r in cur.fetchall()]


def add_item(name, qty, price):
    cur = _conn.execute('INSERT INTO items (name, qty, price) VALUES (?, ?, ?)',
                        (name, qty, price))
    _conn.commit()
    return cur.lastrowid
