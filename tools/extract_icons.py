#!/usr/bin/env python3
"""מחלץ את נתוני האייקונים של אוצריא ל-src/icons.generated.ts.

אוצריא מציירת אייקונים משתי ספריות: FluentUI System Icons (גופן אייקונים)
ו-otzaria_icons (חבילת גיט עם קובצי SVG). התוסף רץ ב-WebView ולכן צריך את
אותם קווי מכחול כ-SVG inline — הסקריפט הזה מייצר אותם מהמקור, כדי שהאייקונים
יהיו זהים לאלו שבתוכנה ולא "דומים".

הרצה (הפלט נשמר בגיט; אין צורך להריץ בכל build):
    python3 tools/extract_icons.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from xml.etree import ElementTree

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

HOME = Path.home()
FLUENT_PKG = HOME / '.pub-cache/hosted/pub.dev/fluentui_system_icons-1.1.273'
OTZARIA_PKG = HOME / '.pub-cache/git/otzaria_icons-596a785ab792a923d4e3b88cea8dd8a1b0c67aaa'
OUTPUT = Path(__file__).resolve().parent.parent / 'src' / 'icons.generated.ts'

# האייקונים שאוצריא מציירת במסכים שהתוסף משחזר (מסך ספרייה ריקה, תוצאות
# חיפוש, מסך PDF וסרגליהם). השם זהה לשם ב-FluentIcons/OtzariaIcons.
FLUENT_ICONS = [
    'add_24_regular',
    'arrow_download_24_regular',
    'arrow_left_24_regular',
    'arrow_next_24_filled',
    'arrow_previous_24_filled',
    'arrow_bidirectional_left_right_24_regular',
    'arrow_swap_24_regular',
    'book_24_regular',
    'chevron_down_12_regular',
    'chevron_down_24_regular',
    'chevron_left_24_regular',
    'chevron_right_24_regular',
    'chevron_up_24_regular',
    'copy_24_regular',
    'dismiss_24_regular',
    'document_multiple_24_filled',
    'document_multiple_24_regular',
    'document_pdf_24_regular',
    'document_search_24_regular',
    'checkbox_checked_24_filled',
    'checkbox_unchecked_24_regular',
    'document_text_24_regular',
    'edit_24_regular',
    'filter_24_regular',
    'folder_24_regular',
    'folder_add_24_regular',
    'folder_open_24_regular',
    'layer_24_regular',
    'library_24_regular',
    'line_horizontal_3_20_regular',
    'more_horizontal_24_regular',
    'open_24_regular',
    'pin_24_filled',
    'pin_24_regular',
    'search_24_filled',
    'search_24_regular',
    'search_info_24_regular',
    'settings_24_regular',
    'subtract_24_regular',
    'text_bullet_list_24_regular',
    'text_quote_24_regular',
    'warning_24_regular',
    'zoom_in_24_regular',
    'zoom_out_24_regular',
]

OTZARIA_ICONS = [
    'document_column_24_regular',
    'list_24_filled',
    'list_24_regular',
    'text_continuous_24_filled',
    'text_continuous_24_regular',
]


def read_fluent_codepoints() -> dict[str, int]:
    source = (FLUENT_PKG / 'lib/src/fluent_icons.dart').read_text(encoding='utf-8')
    pattern = re.compile(
        r'static const IconData (\w+) = IconData\((\d+), '
        r"fontFamily: 'FluentSystemIcons-(\w+)'"
    )
    return {
        f'{name}\0{variant}': int(codepoint)
        for name, codepoint, variant in pattern.findall(source)
    }


def extract_fluent(names: list[str]) -> dict[str, str]:
    codepoints = read_fluent_codepoints()
    fonts: dict[str, TTFont] = {}
    paths: dict[str, str] = {}

    for name in names:
        variant = 'Filled' if name.endswith('_filled') else 'Regular'
        codepoint = codepoints.get(f'{name}\0{variant}')
        if codepoint is None:
            raise SystemExit(f'אייקון Fluent חסר במפה: {name}')

        font = fonts.get(variant)
        if font is None:
            font = TTFont(FLUENT_PKG / f'lib/fonts/FluentSystemIcons-{variant}.ttf')
            fonts[variant] = font

        glyph_name = font.getBestCmap()[codepoint]
        glyph_set = font.getGlyphSet()
        pen = SVGPathPen(glyph_set, ntos=lambda value: f'{round(value, 2):g}')
        glyph_set[glyph_name].draw(pen)
        commands = pen.getCommands()
        if not commands:
            raise SystemExit(f'האייקון {name} ריק בגופן')

        # גופני אייקונים של Fluent בנויים על תיבת em אחת = תיבת האייקון,
        # והבייסליין בתחתיתה. לכן ההמרה ל-viewBox של 24: היפוך ציר Y
        # והזזה בגובה ה-em (ולא ה-ascender, שגדול מהתיבה בחלק מהגופנים).
        units = font['head'].unitsPerEm
        scale = 24 / units
        paths[name] = (commands, f'translate(0 24) scale({scale:g} {-scale:g})')

    return paths


def extract_otzaria(names: list[str]) -> dict[str, str]:
    paths: dict[str, str] = {}
    for name in names:
        svg_file = OTZARIA_PKG / 'assets_src/svg' / f'{name}.svg'
        if not svg_file.exists():
            raise SystemExit(f'קובץ SVG חסר ב-otzaria_icons: {svg_file}')
        root = ElementTree.fromstring(svg_file.read_text(encoding='utf-8'))
        view_box = root.get('viewBox', '0 0 24 24').split()
        commands = ' '.join(
            element.get('d', '')
            for element in root.iter('{http://www.w3.org/2000/svg}path')
        ).strip()
        if not commands:
            raise SystemExit(f'לא נמצא path בקובץ {svg_file}')
        size = float(view_box[2])
        transform = None if size == 24 else f'scale({24 / size:g})'
        paths[name] = (commands, transform)
    return paths


def main() -> None:
    icons = {**extract_fluent(FLUENT_ICONS), **extract_otzaria(OTZARIA_ICONS)}
    lines = [
        '// נוצר אוטומטית על ידי tools/extract_icons.py — אין לערוך ידנית.',
        '// מקור: FluentUI System Icons ו-otzaria_icons, אותן ספריות שאוצריא',
        '// מציירת מהן את האייקונים שלה. כל אייקון הוא path במערכת של 24×24.',
        '',
        'export interface IconShape {',
        '  readonly path: string;',
        '  readonly transform?: string;',
        '}',
        '',
        'export const icons = {',
    ]
    for name in sorted(icons):
        commands, transform = icons[name]
        entry = f"  '{name}': {{ path: '{commands}'"
        if transform:
            entry += f", transform: '{transform}'"
        entry += ' },'
        lines.append(entry)
    lines += [
        '} as const satisfies Record<string, IconShape>;',
        '',
        'export type IconName = keyof typeof icons;',
        '',
    ]
    OUTPUT.write_text('\n'.join(lines), encoding='utf-8')
    print(f'נכתבו {len(icons)} אייקונים אל {OUTPUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
