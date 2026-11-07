#!/usr/bin/env python3
"""Builds tests/fixtures/boc-sample.pdf: a small "Bulletin Officiel de la Cote" laid out like the real BVMAC one
(cover with the All Share Index, equities table with one text object per cell, long names on two lines, a bonds
table that must be ignored). Values are the real rows of BOC n°2632 of 05/11/2026.
Run once:  python3 tests/make-boc-pdf.py   (needs reportlab)"""
import os
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

NB = " "  # Excel's French thousands separator


def fr(n):
    """52500 -> '52 500' with a non-breaking space."""
    return f"{n:,}".replace(",", NB)


ROWS = [
    # name, ISIN (as printed), mnemo, short name, prev, date, vol dem, vol off, vol tr, value, trades, status, open, close, hi, lo, var, next ref, high, low, var y-1
    ("SOCIETE DES EAUX MINERALES DU CAMEROUN", "CM 0000010009", "SEM C", "SEM C", 52500, "04/11/2026", 0, 190, 0, 0, 0, "NC", 52500, 52500, 57750, 47250, "0,00%", 52500, 53000, 48200, "7,14"),
    ("SOCIETE AFRICAINE FORESTIERE ET AGRICOLE DU CAMEROUN", "CM 0000010017", "SAF", "SAFACAM", 38500, "04/11/2026", 32, 10, 10, 385000, 3, "PEq", 38500, 38500, 42350, 34650, "0,00%", 38500, 38500, 30000, "35,09"),
    ("SOCIETE CAMEROUNAISE DE PALMERAIE", "CM 0000010025", "SOCAP", "SOCAPALM", 49000, "04/11/2026", 12, 547, 12, 588000, 2, "PEq", 49000, 49000, 53900, 44100, "0,00%", 49000, 55001, 49000, "1,03"),
    ("LA REGIONALE EPARGNE CREDIT", "CM 0000010041", "REG", "LA REGIONALE", 37499, "04/11/2026", 0, 335, 0, 0, 0, "NC", 37499, 37499, 41249, 33749, "0,00%", 37499, 42000, 37499, "-10,72"),
    ("BANCO NACIONAL DE GUINEA ECUATORIAL", "GQ0000010050", "BANGE", "BANGE", 228085, "04/11/2026", 35, 0, 0, 0, 0, "NC", 228085, 228085, 250894, 205277, "0,00%", 228085, 228085, 223255, "10,00"),
    ("SOCIETE COMMERCIALE GABONAISE DE REASSURANCE", "GA0000010066", "SCGRE", "SCG-Re", 20000, "04/11/2026", 1, 6938, 1, 20000, 1, "PEq", 20000, 20000, 22000, 18000, "0,00%", 20000, 21500, 20000, "-6,98"),
    ("BGFI HOLDING CORPORATION", "GA0000010074", "BHC", "BGFI HC", 82500, "04/11/2026", 5, 7781, 1, 87000, 1, "PEq", 82500, 87000, 90750, 74250, "5,45%", 87000, 93051, 81000, "-"),
]
BONDS = [
    ("ETAT DU CAMEROUN 6,25% NET 2021-2026", "CM0000035063", "ECMR 6,25% 21-26", 10000, 9950, 10945, 8955, "0,00%"),
    ("ETAT DU GABON 6,50% NET 2022-2027", "GA0000020551", "EOG 6,5% 22-27", 9800, 9800, 10780, 8820, "0,00%"),
]


def cell(c, x, y, text, size=6):
    c.setFont("Helvetica", size)
    c.drawString(x, y, str(text))


def build(path, tight=False):
    """tight=True puts every cell right after the previous one (no gap), so the PDF reader glues the numbers."""
    c = canvas.Canvas(path, pagesize=landscape(A4))
    w, h = landscape(A4)
    # ---- page 1: cover ----
    c.setFont("Helvetica-Bold", 16)
    c.drawString(60, h - 80, "BULLETIN OFFICIEL DE LA COTE N° 2632 DU 05/11/2026")
    c.setFont("Helvetica", 10)
    c.drawString(60, h - 110, "BOURSE DES VALEURS MOBILIERES DE L'AFRIQUE CENTRALE")
    c.setFont("Helvetica-Bold", 12)
    c.drawString(60, h - 160, "BVMAC ALL SHARE INDEX")
    c.setFont("Helvetica-Bold", 20)
    c.drawString(60, h - 190, " " + "1" + NB + "123,84")
    c.setFont("Helvetica", 12)
    c.drawString(60, h - 210, "2,18%")
    c.drawString(60, h - 226, "BVMAC-AS")
    c.drawString(140, h - 226, "Variation jour")
    c.showPage()
    # ---- page 2: equities ----
    c.setFont("Helvetica-Bold", 9)
    c.drawString(30, h - 40, "PHYSIONOMIE DU MARCHE / MARCHE DES ACTIONS")
    headers = ["Désignation de l'émetteur", "Code ISIN", "Mnemo", "Nom court de l'émetteur", "Cours précédent", "Date", "Volume demandé",
               "Volume offert", "Volume transigé", "Valeur transigée", "Nbr de trans", "Statut", "Ouver.", "Clôt.", "Seuil Haut", "Seuil Bas",
               "Variation %", "Cours réf.", "Haut", "Bas", "Var. N-1"]
    xs = [30, 150, 205, 240, 290, 330, 372, 402, 432, 462, 505, 530, 555, 590, 625, 660, 695, 730, 765, 800, 832]
    for x, t in zip(xs, headers):
        cell(c, x, h - 70, t, 5)
    y = h - 95
    for r in ROWS:
        name = r[0]
        if len(name) > 30:  # long names wrap on two lines, like Excel "wrap text"
            cut = name.rfind(" ", 0, 30)
            cell(c, xs[0], y + 4, name[:cut])
            cell(c, xs[0], y - 4, name[cut + 1:])
        else:
            cell(c, xs[0], y, name)
        values = list(r[1:])
        x = xs[1]
        for i, v in enumerate(values, start=1):
            text = fr(v) if isinstance(v, int) else v
            cell(c, x if tight else xs[i], y, text)
            x += c.stringWidth(str(text), "Helvetica", 6)
        y -= 26
    cell(c, xs[0], y, "Total")
    cell(c, xs[8], y, "24")
    cell(c, xs[9], y, fr(1080000))
    cell(c, xs[10], y, "7")
    c.showPage()
    # ---- page 3: bonds (must be ignored) ----
    c.setFont("Helvetica-Bold", 9)
    c.drawString(30, h - 40, "MARCHE DES OBLIGATIONS")
    y = h - 80
    for b in BONDS:
        cell(c, 30, y, b[0])
        cell(c, 200, y, b[1])
        cell(c, 260, y, b[2])
        for i, v in enumerate(b[3:]):
            cell(c, 340 + i * 45, y, fr(v) if isinstance(v, int) else v)
        y -= 20
    c.setFont("Helvetica", 8)
    c.drawString(30, y - 30, "L'Indice « BVMAC All Share Index » augmente de 2,18% passant de 1 099,87 à 1 123,84 points.")
    c.showPage()
    c.save()


if __name__ == "__main__":
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
    os.makedirs(here, exist_ok=True)
    for name, tight in (("boc-sample.pdf", False), ("boc-sample-glued.pdf", True)):
        build(os.path.join(here, name), tight)
        print("wrote", os.path.join(here, name))
