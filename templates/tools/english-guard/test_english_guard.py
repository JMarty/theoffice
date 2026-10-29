#!/usr/bin/env python3
"""Tests for english_guard: synthetic false-block and false-pass repros."""
import subprocess, sys, os
HERE=os.path.dirname(os.path.abspath(__file__)); GUARD=os.path.join(HERE,"english_guard.py")
def run(t):
    p=subprocess.run([sys.executable,GUARD],input=t,capture_output=True,text=True); return p.returncode
cases=[]
def check(name,text,want):
    rc=run(text); ok=(rc==want); cases.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: rc={rc} want={want}")

# --- must PASS (English, rc0) ---
check("english_status","Report: 2 new items this morning. Everything is fine. Logged.",0)
check("english_proper_nouns","The Kovacs account and the Smith invoice are both handled.",0)
check("english_briefing","No forced decisions today. The deadline is already satisfied; nothing needs you.",0)
check("empty","",0)
# false-BLOCK repros -> must PASS
check("jack_ma","Jack Ma replied to the partnership email this morning.",0)
check("yoyo_ma","Yo-Yo Ma is playing at the gala; booking confirmed.",0)
check("mai_tai","The Mai Tai order and the Sault startup deck are ready.",0)

# --- must BLOCK (Hungarian, rc1) ---
check("hungarian_deaccented","Holnap elkuldom a szamlat, rendben? A hatarido kedd.",1)
check("hungarian_accents","A kifizetés lezárva, köszönöm. Figyelj a határidőre.",1)
# false-PASS (LEAK) repros: agglutinated forms -> must BLOCK
check("leak_possessive","A mai naplód kész, csatold a fájlt.",1)
check("leak_plumber","A vízvezeték-szerelő már járt, semmi teendőd, minden el van intézve.",1)
check("leak_appt","Holnapra kértem időpontot az ügyfélhez, oké?",1)
# false-block repro -> must PASS (English names Meg + Volt)
check("meg_volt_english","Meg and Volt confirmed the appointment for tomorrow.",0)

print(f"\n{sum(cases)}/{len(cases)} passed")
sys.exit(0 if all(cases) else 1)
