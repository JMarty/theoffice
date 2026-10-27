#!/usr/bin/env python3
"""needs_you_precheck tests: false-RESOLVED repros, all synthetic (no live data)."""
import subprocess, sys, os
HERE=os.path.dirname(os.path.abspath(__file__)); T=os.path.join(HERE,"needs_you_precheck.py")
def verdict(q): return subprocess.run([sys.executable,T,q],capture_output=True,text=True).stdout.strip()
cases=[]
def not_resolved(name,q):
    v=verdict(q); ok=not v.startswith("RESOLVED"); cases.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} (must NOT be hard-RESOLVED): {v[:64]}")
def must(name,q,pfx):
    v=verdict(q); ok=v.startswith(pfx); cases.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} (want {pfx}): {v[:64]}")

# generic recurring items -> the DANGEROUS direction; must NOT hard-resolve (drop)
for n,q in [("parking_permit","parking permit renewal"),
            ("art_supplies","art supplies order for the office"),
            ("payroll_split","payroll split for May"),
            ("grocery_order","grocery order this week"),
            ("expense_split","settle the shared expenses with Alice"),
            ("passport","passport renewal appointment")]:
    not_resolved(n,q)
# stable controls
must("fabricated","zzqx nonexistent widget approval 99999","OPEN")
must("generic_only","approval deadline invoice","OPEN")

# years/amounts must NOT count as case numbers (they would be false hard-RESOLVED = auto-drop)
for n,q in [("conf_year","conference 2026 travel approval needed"),
            ("event_year","meetup dates 2027"),
            ("invoice_year","invoice 2026 for the accountant"),
            ("flight_amount","flight 0 EUR to book")]:
    not_resolved(n,q)

# bare 5-6 digit AMOUNTS/IDs must NOT be case numbers (they collide with unrelated memories)
for n,q in [("deposit","pay 0 EUR deposit to the supplier"),
            ("refund","send the 12345 refund to the tenant"),
            ("wire","wire 23456 to the supplier"),
            ("flight_id","book the 34567 flight")]:
    not_resolved(n,q)

# a short serial inside a formatted ref (invoice year/serial 2026/NNN) is NOT unique
for n,q in [("invoice_100","invoice 2026/100 for the accountant"),
            ("invoice_200_unpaid","invoice 2026/200 still unpaid"),
            ("invoice_300","bill 2026/300 to pay")]:
    not_resolved(n,q)

# a slashed AMOUNT shape must not re-arm a strong anchor (only multi-group case-refs do)
not_resolved("slashed_amount","pay 12/0 EUR deposit to the supplier")

print(f"\n{sum(cases)}/{len(cases)} passed")
sys.exit(0 if all(cases) else 1)
