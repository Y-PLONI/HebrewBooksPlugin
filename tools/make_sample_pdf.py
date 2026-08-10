#!/usr/bin/env python3
"""יוצר PDF דמה לבדיקות התצוגה של התוסף (tools/preview-server.mjs)."""

from __future__ import annotations

import sys
from pathlib import Path

PAGES = 8
WIDTH, HEIGHT = 595, 842


def page_content(number: int) -> bytes:
    lines = []
    lines.append('0.85 0.85 0.85 rg')
    lines.append(f'40 40 {WIDTH - 80} {HEIGHT - 80} re f')
    lines.append('0 0 0 rg')
    lines.append('BT /F1 28 Tf 70 760 Td (HebrewBooks sample) Tj ET')
    lines.append(f'BT /F1 20 Tf 70 720 Td (page {number} of {PAGES}) Tj ET')
    for row in range(24):
        y = 680 - row * 26
        width = (WIDTH - 160) - (row % 4) * 40
        lines.append('0.45 0.45 0.45 rg')
        lines.append(f'80 {y} {width} 10 re f')
    return '\n'.join(lines).encode('latin-1')


def build() -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    page_ids: list[int] = []
    content_ids: list[int] = []
    for number in range(1, PAGES + 1):
        content = page_content(number)
        content_ids.append(add(b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream'))
        page_ids.append(0)

    pages_id = len(objects) + PAGES + 1
    for index in range(PAGES):
        page_ids[index] = add(
            b'<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] '
            b'/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>'
            % (pages_id, WIDTH, HEIGHT, font, content_ids[index])
        )
    kids = b' '.join(b'%d 0 R' % identifier for identifier in page_ids)
    pages = add(b'<< /Type /Pages /Count %d /Kids [%s] >>' % (PAGES, kids))
    assert pages == pages_id, 'מזהה עץ העמודים אינו עקבי'
    outlines_children = []
    for index in range(0, PAGES, 3):
        outlines_children.append(index)
    catalog = add(b'<< /Type /Catalog /Pages %d 0 R >>' % pages)

    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'

    xref_offset = len(out)
    out += b'xref\n0 %d\n' % (len(objects) + 1)
    out += b'0000000000 65535 f \n'
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (
        len(objects) + 1,
        catalog,
        xref_offset,
    )
    return bytes(out)


if __name__ == '__main__':
    target = Path(sys.argv[1] if len(sys.argv) > 1 else 'sample.pdf')
    target.write_bytes(build())
    print(f'נכתב {target} ({PAGES} עמודים)', file=sys.stderr)
