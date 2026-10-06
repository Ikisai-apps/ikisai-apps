#!/usr/bin/env python3
"""Espera a que la CI de una PR termine y la fusiona con squash si está en verde. Pensado para lanzarlo en segundo plano
y seguir trabajando: `python scripts/pr_wait_merge.py <número> [--timeout 1800] [--rerun-flaky 1]`.
Sale 0 si fusionó, 1 si la CI falló (no fusiona), 2 si agotó el tiempo. Nunca fusiona en rojo."""
import argparse, json, subprocess, sys, time

OK = {"SUCCESS", "SKIPPED", "NEUTRAL"}

def gh(*args):
  return subprocess.run(["gh", *args], capture_output=True, text=True)

def checks(pr):
  out = gh("pr", "view", str(pr), "--json", "statusCheckRollup,state,mergeStateStatus", "--jq", "{s:.state, m:.mergeStateStatus, c:[.statusCheckRollup[]|{name,status,conclusion}]}").stdout.strip()
  return json.loads(out) if out else {"s": "?", "m": "?", "c": []}

def main():
  ap = argparse.ArgumentParser(description=__doc__)
  ap.add_argument("pr", type=int); ap.add_argument("--timeout", type=int, default=1800); ap.add_argument("--rerun-flaky", type=int, default=1, help="relanzar jobs fallidos de Playwright hasta N veces")
  a = ap.parse_args(); start = time.time(); reruns = 0
  while time.time() - start < a.timeout:
    info = checks(a.pr)
    if info["s"] == "MERGED": print("ya fusionada"); return 0
    if info["s"] != "OPEN": print("PR no abierta:", info["s"]); return 1
    c = info["c"]
    if c and all(x["status"] == "COMPLETED" for x in c):
      bad = [x for x in c if x["conclusion"] not in OK]
      if not bad:
        if info["m"] == "DIRTY": print("conflictos con main: rebasa y vuelve a empujar"); return 1
        r = gh("pr", "merge", str(a.pr), "--squash", "--delete-branch")
        print("fusionada" if r.returncode == 0 else "no se pudo fusionar: " + (r.stderr or r.stdout).strip()[-200:]); return 0 if r.returncode == 0 else 1
      if reruns < a.rerun_flaky and all("Playwright" in x["name"] for x in bad):
        run = gh("pr", "view", str(a.pr), "--json", "headRefName", "--jq", ".headRefName").stdout.strip()
        rid = gh("run", "list", "--workflow", "checks.yml", "--limit", "5", "--branch", run, "--json", "databaseId", "--jq", ".[0].databaseId").stdout.strip()
        if rid: gh("run", "rerun", rid, "--failed"); reruns += 1; print("Playwright en rojo; relanzado una vez (run", rid + ")"); time.sleep(45); continue
      print("CI en rojo:", [(x["name"], x["conclusion"]) for x in bad]); return 1
    time.sleep(15)
  print("tiempo agotado esperando la CI"); return 2

if __name__ == "__main__":
  sys.exit(main())
