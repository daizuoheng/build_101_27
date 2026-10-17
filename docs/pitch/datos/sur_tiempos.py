# Tiempos de cierre del Sistema Único de Reclamos (SUR) de la Intendencia de Montevideo, desde los datos abiertos.
# Fuente: https://catalogodatos.gub.uy/dataset/reclamos-registrados-en-el-sistema-unico-de-reclamos-de-la-intendencia-de-montevideo
# Archivo usado: reclamos.zip, Last-Modified 11/10/2026, 1.709.419 filas, ingresos hasta el 30/09/2026.
# Uso: python3 sur_tiempos.py Reclamos.csv
# Días = FECHA_DESDE_EN_ESTADO - FECHA_INGRESO_RECLAMO, solo DESC_ESTADO = Finalizado. El dataset no guarda historial
# de estados: FECHA_DESDE_EN_ESTADO es la fecha en que entró al estado actual (para finalizados, la de cierre).
import csv, sys, collections, statistics
from datetime import date
p = sys.argv[1]
def d(s): return date(int(s[:4]), int(s[5:7]), int(s[8:10]))
by_close = collections.defaultdict(list)   # finalizados por año de cierre
by_ing = collections.defaultdict(list)     # finalizados por año de ingreso
open_by_year = collections.Counter(); ing_by_year = collections.Counter()
types24 = collections.Counter(); grp_cont = collections.defaultdict(list)
neg = 0
with open(p, newline='', encoding='utf-8', errors='replace') as f:
    for r in csv.DictReader(f):
        fi = d(r['FECHA_INGRESO_RECLAMO']); y = fi.year
        ing_by_year[y] += 1
        e = r['DESC_ESTADO']
        if e in ('En Proceso', 'Ingresado'): open_by_year[y] += 1
        if e != 'Finalizado': continue
        fc = d(r['FECHA_DESDE_EN_ESTADO']); days = (fc - fi).days
        if days < 0: neg += 1; continue
        by_close[fc.year].append(days); by_ing[y].append(days)
        if fc.year >= 2024:
            grp_cont[r['DESC_GRUPO']].append(days)
def summ(xs):
    xs = sorted(xs); n = len(xs)
    return n, statistics.median(xs), round(100*sum(x>90 for x in xs)/n,1), round(100*sum(x<=1 for x in xs)/n,1)
print('negativos', neg)
print('cierre 2024-2026 (n, mediana, %>90d, %<=1d):', summ(by_close[2024]+by_close[2025]+by_close[2026]))
for y in (2023,2024,2025,2026): print(' cierre', y, summ(by_close[y]))
for y in (2023,2024,2025): print(' ingreso', y, summ(by_ing[y]), 'aún abiertos:', open_by_year[y], 'de', ing_by_year[y])
print('ingresos 2025:', ing_by_year[2025], ' 2026 (ene-sep):', ing_by_year[2026])
print('grupos con más cierres 2024+ (n, mediana, %>90):')
for g, xs in sorted(grp_cont.items(), key=lambda kv: -len(kv[1]))[:10]: print('  ', g, summ(xs)[:3])
