#!/usr/bin/env python3
"""Packar PNG-filer till en .ico — utan beroenden, i projektets no-build-anda.

ICO-formatet tillåter PNG-kodade poster sedan Vista, och varje webbläsare som
läser .ico alls klarar dem. Alternativet vore BMP-kodning för hand, vilket
kräver att alfakanalen skrivs som en separat AND-mask — onödigt när PNG duger.

Bruk: packa-ico.py ut.ico in16.png in32.png in48.png
"""
import struct
import sys
import pathlib


def packa(mål: pathlib.Path, källor: list[pathlib.Path]) -> None:
    poster = []
    for p in källor:
        data = p.read_bytes()
        if data[:8] != b'\x89PNG\r\n\x1a\n':
            raise SystemExit(f'{p} är inte en PNG')
        # IHDR: bredd och höjd ligger som big-endian uint32 på offset 16.
        bredd, höjd = struct.unpack('>II', data[16:24])
        if bredd > 256 or höjd > 256:
            raise SystemExit(f'{p} är {bredd}x{höjd} — ICO klarar max 256')
        poster.append((bredd, höjd, data))

    poster.sort(key=lambda t: t[0])
    # ICONDIR: reserverad 0, typ 1 (ikon), antal poster.
    ut = bytearray(struct.pack('<HHH', 0, 1, len(poster)))
    # Varje ICONDIRENTRY är 16 byte; bilddatan börjar efter hela katalogen.
    offset = 6 + 16 * len(poster)
    for bredd, höjd, data in poster:
        ut += struct.pack(
            '<BBBBHHII',
            0 if bredd == 256 else bredd,   # 0 betyder 256
            0 if höjd == 256 else höjd,
            0,                              # palett: 0 = ingen
            0,                              # reserverad
            1,                              # färgplan
            32,                             # bitar per pixel
            len(data),
            offset,
        )
        offset += len(data)
    for _, _, data in poster:
        ut += data
    mål.write_bytes(ut)
    print(f'{mål.name}: {len(poster)} storlekar '
          f'({", ".join(f"{b}x{h}" for b, h, _ in poster)}), {len(ut)} byte')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    packa(pathlib.Path(sys.argv[1]), [pathlib.Path(a) for a in sys.argv[2:]])
