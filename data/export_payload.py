#!/usr/bin/env python3
"""
Export a compact JSON payload from ksp.db for bundling into the Catalyst function.
Short keys keep the file small enough to ship inside a serverless bundle.

Usage:  python3 export_payload.py [path/to/ksp.db] [output.json]
"""
import json, sqlite3, sys, os

db_path = sys.argv[1] if len(sys.argv) > 1 else "out/ksp.db"
out_path = sys.argv[2] if len(sys.argv) > 2 else "ksp_payload.json"

con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
cur = con.cursor()

# ---- accused records, joined with case + station context
cur.execute("""
SELECT a.AccusedMasterID  AS id,
       a.AccusedName      AS nm,
       a.GenderID         AS g,
       a.AgeYear          AS ag,
       cm.CrimeNo         AS cn,
       cm.CrimeRegisteredDate AS dt,
       u.UnitName         AS st,
       d.DistrictName     AS di,
       ch.CrimeGroupName  AS hd,
       csh.CrimeHeadName  AS sh,
       st2.CaseStatusName AS cs,
       go.LookupValue     AS gv
FROM Accused a
JOIN CaseMaster cm      ON cm.CaseMasterID = a.CaseMasterID
JOIN Unit u             ON u.UnitID        = cm.PoliceStationID
JOIN District d         ON d.DistrictID    = u.DistrictID
LEFT JOIN CrimeHead ch      ON ch.CrimeHeadID    = cm.CrimeMajorHeadID
LEFT JOIN CrimeSubHead csh  ON csh.CrimeSubHeadID = cm.CrimeMinorHeadID
LEFT JOIN CaseStatusMaster st2 ON st2.CaseStatusID = cm.CaseStatusID
LEFT JOIN GravityOffence go ON go.GravityOffenceID = cm.GravityOffenceID
""")
accused = [dict(r) for r in cur.fetchall()]

# ---- case-level aggregates for the analytics panel
cur.execute("""
SELECT d.DistrictName AS di, ch.CrimeGroupName AS hd,
       substr(cm.CrimeRegisteredDate,1,4) AS yr, COUNT(*) AS n
FROM CaseMaster cm
JOIN Unit u     ON u.UnitID = cm.PoliceStationID
JOIN District d ON d.DistrictID = u.DistrictID
LEFT JOIN CrimeHead ch ON ch.CrimeHeadID = cm.CrimeMajorHeadID
GROUP BY d.DistrictName, ch.CrimeGroupName, yr
""")
trends = [dict(r) for r in cur.fetchall()]

cur.execute("SELECT COUNT(*) FROM CaseMaster")
n_cases = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM Unit WHERE TypeID IN (1,5)")
n_stations = cur.fetchone()[0]
cur.execute("SELECT MIN(CrimeRegisteredDate), MAX(CrimeRegisteredDate) FROM CaseMaster")
lo, hi = cur.fetchone()

payload = {
    "meta": {
        "cases": n_cases,
        "accusedRecords": len(accused),
        "stations": n_stations,
        "dateRange": [lo, hi],
        "source": "synthetic FIR corpus, KSP Datathon 2026",
    },
    "accused": accused,
    "trends": trends,
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

size = os.path.getsize(out_path)
print(f"wrote {out_path}")
print(f"  accused records : {len(accused)}")
print(f"  trend rows      : {len(trends)}")
print(f"  size            : {size/1024:.0f} KB")
con.close()
