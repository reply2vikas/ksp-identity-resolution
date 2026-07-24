#!/usr/bin/env python3
"""
KSP Datathon 2026 - Synthetic FIR Dataset Generator
Schema-faithful to Police_FIR_ER_Diagram.

Generates:
  - out/ksp.db      : SQLite DB (local dev + can be bundled)
  - out/csv/*.csv   : CSVs for Catalyst Data Store bulk import
  - out/truth.json  : ground-truth identity clusters (for eval, NOT shipped to model)

Design note: duplicate/messy identities are DELIBERATELY seeded so the
entity-resolution demo has real signal to find.
"""

import csv, json, os, random, sqlite3, unicodedata
from datetime import date, datetime, timedelta

random.seed(20260726)
OUT = "out"
CSVD = os.path.join(OUT, "csv")
os.makedirs(CSVD, exist_ok=True)

# ---------------------------------------------------------------- reference data

STATES = [(1, "Karnataka", 1, 1), (2, "Tamil Nadu", 1, 1), (3, "Maharashtra", 1, 1),
          (4, "Telangana", 1, 1), (5, "Kerala", 1, 1), (6, "Goa", 1, 1)]

KA_DISTRICTS = [
    "Bengaluru City", "Bengaluru Rural", "Mysuru", "Mangaluru", "Belagavi",
    "Kalaburagi", "Hubballi-Dharwad", "Tumakuru", "Shivamogga", "Ballari",
    "Vijayapura", "Davanagere", "Udupi", "Hassan", "Raichur", "Bidar",
]
DISTRICTS = []
for i, d in enumerate(KA_DISTRICTS):
    DISTRICTS.append((4400 + i + 1, d, 1, 1))
DISTRICTS += [(5001, "Chennai", 2, 1), (5002, "Pune", 3, 1), (5003, "Hyderabad", 4, 1)]

UNIT_TYPES = [(1, "Police Station", "City", 3, 1), (2, "Circle Office", "District", 2, 1),
              (3, "District HQ", "District", 2, 1), (4, "State CID", "State", 1, 1),
              (5, "Cyber Crime PS", "City", 3, 1)]

PS_SUFFIX = ["North", "South", "East", "West", "Central", "Town", "Rural",
             "Market", "Railway", "Traffic"]

RANKS = [(1, "DGP", 1, 1), (2, "IGP", 2, 1), (3, "DIG", 3, 1), (4, "SP", 4, 1),
         (5, "DySP", 5, 1), (6, "Inspector", 6, 1), (7, "Sub Inspector", 7, 1),
         (8, "Head Constable", 8, 1), (9, "Constable", 9, 1)]

DESIGNATIONS = [(1, "Station House Officer", 1, 1), (2, "Investigating Officer", 1, 2),
                (3, "Circle Inspector", 1, 3), (4, "Superintendent of Police", 1, 4),
                (5, "Cyber Analyst", 1, 5)]

CASE_CATEGORY = [(1, "FIR"), (3, "UDR"), (4, "PAR"), (8, "Zero FIR")]
GRAVITY = [(1, "Heinous"), (2, "Non-Heinous"), (3, "Petty")]

CASE_STATUS = [(1, "Under Investigation"), (2, "Charge Sheeted"), (3, "Closed - Undetected"),
               (4, "Closed - False"), (5, "Trial In Progress"), (6, "Disposed")]

RELIGION = [(1, "Hindu"), (2, "Muslim"), (3, "Christian"), (4, "Jain"), (5, "Sikh"), (6, "Other")]
CASTE = [(1, "General"), (2, "OBC"), (3, "SC"), (4, "ST"), (5, "Not Recorded")]
OCCUPATION = [(1, "Farmer"), (2, "Daily Wage Labourer"), (3, "Government Employee"),
              (4, "Private Employee"), (5, "Student"), (6, "Business"), (7, "Driver"),
              (8, "Homemaker"), (9, "Unemployed"), (10, "IT Professional")]

ACTS = [("IPC", "Indian Penal Code, 1860", "IPC", 1),
        ("BNS", "Bharatiya Nyaya Sanhita, 2023", "BNS", 1),
        ("NDPS", "Narcotic Drugs and Psychotropic Substances Act, 1985", "NDPS", 1),
        ("ITA", "Information Technology Act, 2000", "IT Act", 1),
        ("MVA", "Motor Vehicles Act, 1988", "MV Act", 1),
        ("ARMS", "Arms Act, 1959", "Arms Act", 1)]

SECTIONS = [
    ("IPC", "302", "Punishment for murder"),
    ("IPC", "307", "Attempt to murder"),
    ("IPC", "376", "Punishment for rape"),
    ("IPC", "379", "Punishment for theft"),
    ("IPC", "392", "Punishment for robbery"),
    ("IPC", "395", "Punishment for dacoity"),
    ("IPC", "420", "Cheating and dishonestly inducing delivery of property"),
    ("IPC", "406", "Punishment for criminal breach of trust"),
    ("IPC", "323", "Punishment for voluntarily causing hurt"),
    ("IPC", "498A", "Cruelty by husband or relatives"),
    ("BNS", "103", "Punishment for murder"),
    ("BNS", "318", "Cheating"),
    ("BNS", "309", "Robbery"),
    ("NDPS", "20", "Contravention in relation to cannabis"),
    ("NDPS", "21", "Contravention in relation to manufactured drugs"),
    ("ITA", "66C", "Identity theft"),
    ("ITA", "66D", "Cheating by personation using computer resource"),
    ("MVA", "184", "Driving dangerously"),
    ("ARMS", "25", "Punishment for possession of arms"),
]

CRIME_HEADS = [(1, "Crimes Against Body", 1), (2, "Crimes Against Property", 1),
               (3, "Crimes Against Women", 1), (4, "Economic Offences", 1),
               (5, "Cyber Crimes", 1), (6, "Narcotic Offences", 1),
               (7, "Traffic Offences", 1), (8, "Arms Act Offences", 1)]

CRIME_SUBHEADS = [
    (101, 1, "Murder", 1), (102, 1, "Attempt to Murder", 2), (103, 1, "Grievous Hurt", 3),
    (201, 2, "Theft", 1), (202, 2, "Burglary", 2), (203, 2, "Robbery", 3),
    (204, 2, "Dacoity", 4), (205, 2, "Vehicle Theft", 5),
    (301, 3, "Dowry Harassment", 1), (302, 3, "Sexual Assault", 2), (303, 3, "Domestic Cruelty", 3),
    (401, 4, "Cheating / Fraud", 1), (402, 4, "Criminal Breach of Trust", 2),
    (403, 4, "Chit Fund Fraud", 3),
    (501, 5, "Online Financial Fraud", 1), (502, 5, "Identity Theft", 2),
    (503, 5, "Cryptocurrency Fraud", 3), (504, 5, "Social Media Impersonation", 4),
    (601, 6, "Ganja Possession", 1), (602, 6, "Synthetic Drug Trafficking", 2),
    (701, 7, "Rash Driving", 1), (702, 7, "Hit and Run", 2),
    (801, 8, "Illegal Arms Possession", 1),
]

# head -> plausible (act, section) list
HEAD_SECTIONS = {
    1: [("IPC", "302"), ("IPC", "307"), ("IPC", "323"), ("BNS", "103")],
    2: [("IPC", "379"), ("IPC", "392"), ("IPC", "395"), ("BNS", "309")],
    3: [("IPC", "376"), ("IPC", "498A")],
    4: [("IPC", "420"), ("IPC", "406"), ("BNS", "318")],
    5: [("ITA", "66C"), ("ITA", "66D"), ("IPC", "420")],
    6: [("NDPS", "20"), ("NDPS", "21")],
    7: [("MVA", "184")],
    8: [("ARMS", "25")],
}

# ---------------------------------------------------------------- name machinery

FIRST_M = ["Ravi", "Suresh", "Manjunath", "Praveen", "Girish", "Basavaraj", "Shivakumar",
           "Naveen", "Anand", "Harish", "Kiran", "Mahesh", "Santhosh", "Vinod", "Prakash",
           "Ramesh", "Nagaraj", "Dinesh", "Chetan", "Arun", "Imran", "Faizal", "Yusuf",
           "Vikram", "Deepak", "Sandeep", "Rakesh", "Gopal", "Srinivas", "Venkatesh"]
FIRST_F = ["Lakshmi", "Savitha", "Kavitha", "Rekha", "Sunitha", "Anitha", "Divya",
           "Shwetha", "Pooja", "Ashwini", "Meera", "Nandini", "Roopa", "Chaitra",
           "Bhavana", "Sushma", "Vidya", "Ayesha", "Fatima", "Priya"]
SURNAMES = ["Gowda", "Shetty", "Rao", "Naik", "Hegde", "Patil", "Kulkarni", "Reddy",
            "Kumar", "Murthy", "Bhat", "Jain", "Shastri", "Desai", "Kamath", "Poojary",
            "Achar", "Nayak", "Sharma", "Iyer", "Khan", "Sheikh", "Ansari"]

KANNADA_MAP = {
    "Ravi": "ರವಿ", "Kumar": "ಕುಮಾರ್", "Suresh": "ಸುರೇಶ್", "Manjunath": "ಮಂಜುನಾಥ್",
    "Gowda": "ಗೌಡ", "Shetty": "ಶೆಟ್ಟಿ", "Rao": "ರಾವ್", "Naik": "ನಾಯಕ್",
    "Lakshmi": "ಲಕ್ಷ್ಮಿ", "Praveen": "ಪ್ರವೀಣ್", "Imran": "ಇಮ್ರಾನ್", "Khan": "ಖಾನ್",
    "Basavaraj": "ಬಸವರಾಜ್", "Patil": "ಪಾಟೀಲ್", "Nagaraj": "ನಾಗರಾಜ್",
}

def kannada(name: str):
    parts = name.split()
    if all(p in KANNADA_MAP for p in parts):
        return " ".join(KANNADA_MAP[p] for p in parts)
    return None

def messy_variants(first, last):
    """Realistic data-entry variants of the same human name."""
    full = f"{first} {last}"
    v = [
        full,
        f"{first}{last}",                       # Ravikumar
        f"{first} {last[0]}",                   # Ravi K
        f"{last} {first}",                      # Kumar Ravi (order flip)
        f"{first[0]}. {last}",                  # R. Kumar
        f"{first} {last}".upper(),              # RAVI KUMAR
        f"{first}  {last}",                     # double space
        f"{first} {last} ",                     # trailing space
        f"{first[0]}.{first[1:]} {last}",       # R.avi Kumar (bad entry)
    ]
    k = kannada(full)
    if k:
        v.append(k)
    # common transliteration wobble
    v.append(full.replace("th", "t").replace("ee", "i").replace("oo", "u"))
    return list(dict.fromkeys(v))

def rand_name(gender):
    f = random.choice(FIRST_M if gender == "M" else FIRST_F)
    return f, random.choice(SURNAMES)

# ---------------------------------------------------------------- build masters

units, employees, courts = [], [], []
uid = 1
for d_id, d_name, s_id, _ in DISTRICTS:
    n_ps = 6 if "Bengaluru City" in d_name else (4 if s_id == 1 else 2)
    for j in range(n_ps):
        t = 5 if (j == 0 and random.random() < 0.35) else 1
        nm = f"{d_name} {PS_SUFFIX[j % len(PS_SUFFIX)]} PS" if t == 1 else f"{d_name} Cyber Crime PS"
        units.append((uid, nm, t, None, 1, s_id, d_id, 1))
        uid += 1
    units.append((uid, f"{d_name} District HQ", 3, None, 1, s_id, d_id, 1)); uid += 1

court_id = 1
for d_id, d_name, s_id, _ in DISTRICTS:
    for cn in ["JMFC Court", "Sessions Court"]:
        courts.append((court_id, f"{d_name} {cn}", d_id, s_id, 1)); court_id += 1

emp_id = 1
for u in units:
    for rank_id, desig_id, cnt in [(6, 1, 1), (7, 2, 3), (8, 2, 2), (5, 3, 1)]:
        for _ in range(cnt):
            g = "M" if random.random() < 0.82 else "F"
            f, l = rand_name(g)
            employees.append((emp_id, u[6], u[0], rank_id, desig_id,
                              f"KGID{100000+emp_id}", f"{f} {l}",
                              (date(1970, 1, 1) + timedelta(days=random.randint(0, 9000))).isoformat(),
                              1 if g == "M" else 2, random.randint(1, 8), 0))
            emp_id += 1

ka_units = [u for u in units if u[5] == 1 and u[2] in (1, 5)]

# ---------------------------------------------------------------- identity pool
# Each "person" = a real human who may appear under several spellings.

class Person:
    __slots__ = ("pid", "first", "last", "gender", "birth_year", "home_district",
                 "variants", "mo_heads", "phone")
    def __init__(self, pid, first, last, gender, birth_year, home_district, mo_heads):
        self.pid = pid; self.first = first; self.last = last
        self.gender = gender; self.birth_year = birth_year
        self.home_district = home_district; self.mo_heads = mo_heads
        self.variants = messy_variants(first, last)
        self.phone = f"9{random.randint(100000000, 999999999)}"

people = []
pid = 1
# 60 "repeat offender" identities that WILL appear multiple times, messily
REPEAT_N = 60
for _ in range(REPEAT_N):
    g = "M" if random.random() < 0.88 else "F"
    f, l = rand_name(g)
    mo = random.sample([2, 4, 5, 6, 1, 8], k=random.choice([1, 1, 2]))
    people.append(Person(pid, f, l, g, random.randint(1975, 2003),
                         random.choice([d[0] for d in DISTRICTS if d[2] == 1]), mo))
    pid += 1

# ---------------------------------------------------------------- generate cases

cases, complainants, victims, accused, arrests, actsecs, chargesheets = [], [], [], [], [], [], []
truth = {}          # accused_row_id -> person_id  (ground truth for eval)

N_CASES = 1400
START = date(2023, 1, 1)
END = date(2026, 6, 30)
span = (END - START).days

subhead_by_head = {}
for sh in CRIME_SUBHEADS:
    subhead_by_head.setdefault(sh[1], []).append(sh)

# hotspot weighting: some districts get disproportionate cyber/property crime
HOTSPOT = {4401: 3.2, 4403: 1.6, 4407: 1.4}   # Bengaluru City, Mysuru, Hubballi

serials = {}
case_id = 1
comp_id = 1
vic_id = 1
acc_id = 1
arr_id = 1
cs_id = 1

def pick_unit():
    w = [HOTSPOT.get(u[6], 1.0) for u in ka_units]
    return random.choices(ka_units, weights=w, k=1)[0]

for _ in range(N_CASES):
    unit = pick_unit()
    d_id = unit[6]
    reg = START + timedelta(days=random.randint(0, span))
    yr = reg.year

    # cyber crime skews toward cyber units and grows over time
    if unit[2] == 5:
        head = random.choices([5, 4, 2], weights=[6, 2, 1], k=1)[0]
    else:
        growth = 1 + (yr - 2023) * 0.9
        head = random.choices([1, 2, 3, 4, 5, 6, 7, 8],
                              weights=[6, 22, 9, 8, 5 * growth, 6, 14, 3], k=1)[0]
    sub = random.choice(subhead_by_head[head])

    cat = 1 if random.random() < 0.9 else random.choice([3, 4, 8])
    key = (unit[0], cat, yr)
    serials[key] = serials.get(key, 0) + 1
    crime_no = f"{cat}{d_id:04d}{unit[0]:04d}{yr}{serials[key]:05d}"
    case_no = f"{yr}{serials[key]:05d}"

    grav = 1 if head in (1, 3) and random.random() < 0.6 else random.choice([2, 2, 3])
    status = random.choices([1, 2, 3, 4, 5, 6], weights=[30, 28, 14, 6, 15, 7], k=1)[0]

    offs = [e for e in employees if e[2] == unit[0]]
    officer = random.choice(offs) if offs else random.choice(employees)
    ct = random.choice([c for c in courts if c[2] == d_id] or courts)

    inc_from = datetime.combine(reg - timedelta(days=random.randint(0, 6)),
                                datetime.min.time()) + timedelta(hours=random.randint(0, 23))
    inc_to = inc_from + timedelta(hours=random.randint(0, 12))
    info_rx = inc_to + timedelta(hours=random.randint(1, 40))

    lat = round(12.0 + random.random() * 5.5, 6)
    lon = round(74.5 + random.random() * 4.0, 6)

    brief = f"{sub[2]} reported within jurisdiction of {unit[1]}. Investigation initiated under applicable sections."

    cases.append((case_id, crime_no, case_no, reg.isoformat(), officer[0], unit[0],
                  cat, grav, head, sub[0], status, ct[0],
                  inc_from.isoformat(sep=" "), inc_to.isoformat(sep=" "),
                  info_rx.isoformat(sep=" "), lat, lon, brief))

    # act-sections
    for order, (a, s) in enumerate(random.sample(HEAD_SECTIONS[head],
                                   k=min(len(HEAD_SECTIONS[head]), random.choice([1, 1, 2]))), 1):
        actsecs.append((case_id, a, s, order, order))

    # complainant
    g = random.choice(["M", "F"])
    cf, cl = rand_name(g)
    complainants.append((comp_id, case_id, f"{cf} {cl}", random.randint(19, 68),
                         random.choice(OCCUPATION)[0], random.choice(RELIGION)[0],
                         random.choice(CASTE)[0], 1 if g == "M" else 2))
    comp_id += 1

    # victims
    if head in (1, 3, 2):
        for _ in range(random.choice([1, 1, 1, 2])):
            g = "F" if head == 3 else random.choice(["M", "M", "F"])
            vf, vl = rand_name(g)
            victims.append((vic_id, case_id, f"{vf} {vl}", random.randint(6, 80),
                            1 if g == "M" else 2, "0"))
            vic_id += 1

    # accused — this is where identity messiness lives
    n_acc = random.choices([0, 1, 2, 3], weights=[18, 52, 22, 8], k=1)[0]
    used = set()
    for k in range(n_acc):
        repeat_pool = [p for p in people if head in p.mo_heads]
        use_repeat = repeat_pool and random.random() < 0.42
        if use_repeat:
            p = random.choice(repeat_pool)
            if p.pid in used:
                use_repeat = False
        if use_repeat:
            used.add(p.pid)
            # pick a spelling variant — biased so no single form dominates
            name = random.choice(p.variants)
            age = yr - p.birth_year + random.choice([-1, 0, 0, 0, 1])  # age drift
            gender = p.gender
            truth[acc_id] = p.pid
        else:
            gender = "M" if random.random() < 0.87 else "F"
            f, l = rand_name(gender)
            name = f"{f} {l}"
            age = random.randint(18, 62)
        accused.append((acc_id, case_id, name, age, gender, f"A{k+1}"))

        # arrest
        if random.random() < 0.55:
            ad = reg + timedelta(days=random.randint(0, 90))
            arrests.append((arr_id, case_id, random.choice([1, 1, 1, 2]), ad.isoformat(),
                            1, d_id, unit[0], officer[0], ct[0], acc_id, 1, 0))
            arr_id += 1
        acc_id += 1

    # chargesheet
    if status in (2, 5, 6):
        csd = reg + timedelta(days=random.randint(30, 200))
        chargesheets.append((cs_id, case_id, csd.isoformat() + " 10:30:00",
                             random.choices(["A", "B", "C"], weights=[8, 1, 2], k=1)[0], officer[0]))
        cs_id += 1

    case_id += 1

# ---------------------------------------------------------------- write SQLite

db_path = os.path.join(OUT, "ksp.db")
if os.path.exists(db_path):
    os.remove(db_path)
con = sqlite3.connect(db_path)
cur = con.cursor()

cur.executescript("""
CREATE TABLE State(StateID INT PRIMARY KEY, StateName TEXT, NationalityID INT, Active INT);
CREATE TABLE District(DistrictID INT PRIMARY KEY, DistrictName TEXT, StateID INT, Active INT);
CREATE TABLE UnitType(UnitTypeID INT PRIMARY KEY, UnitTypeName TEXT, CityDistState TEXT, Hierarchy INT, Active INT);
CREATE TABLE Unit(UnitID INT PRIMARY KEY, UnitName TEXT, TypeID INT, ParentUnit INT, NationalityID INT, StateID INT, DistrictID INT, Active INT);
CREATE TABLE Rank(RankID INT PRIMARY KEY, RankName TEXT, Hierarchy INT, Active INT);
CREATE TABLE Designation(DesignationID INT PRIMARY KEY, DesignationName TEXT, Active INT, SortOrder INT);
CREATE TABLE Employee(EmployeeID INT PRIMARY KEY, DistrictID INT, UnitID INT, RankID INT, DesignationID INT,
                      KGID TEXT, FirstName TEXT, EmployeeDOB TEXT, GenderID INT, BloodGroupID INT, PhysicallyChallenged INT);
CREATE TABLE Court(CourtID INT PRIMARY KEY, CourtName TEXT, DistrictID INT, StateID INT, Active INT);
CREATE TABLE CaseCategory(CaseCategoryID INT PRIMARY KEY, LookupValue TEXT);
CREATE TABLE GravityOffence(GravityOffenceID INT PRIMARY KEY, LookupValue TEXT);
CREATE TABLE CaseStatusMaster(CaseStatusID INT PRIMARY KEY, CaseStatusName TEXT);
CREATE TABLE ReligionMaster(ReligionID INT PRIMARY KEY, ReligionName TEXT);
CREATE TABLE CasteMaster(caste_master_id INT PRIMARY KEY, caste_master_name TEXT);
CREATE TABLE OccupationMaster(OccupationID INT PRIMARY KEY, OccupationName TEXT);
CREATE TABLE Act(ActCode TEXT PRIMARY KEY, ActDescription TEXT, ShortName TEXT, Active INT);
CREATE TABLE Section(ActCode TEXT, SectionCode TEXT, SectionDescription TEXT, Active INT);
CREATE TABLE CrimeHead(CrimeHeadID INT PRIMARY KEY, CrimeGroupName TEXT, Active INT);
CREATE TABLE CrimeSubHead(CrimeSubHeadID INT PRIMARY KEY, CrimeHeadID INT, CrimeHeadName TEXT, SeqID INT);
CREATE TABLE CaseMaster(CaseMasterID INT PRIMARY KEY, CrimeNo TEXT, CaseNo TEXT, CrimeRegisteredDate TEXT,
    PolicePersonID INT, PoliceStationID INT, CaseCategoryID INT, GravityOffenceID INT,
    CrimeMajorHeadID INT, CrimeMinorHeadID INT, CaseStatusID INT, CourtID INT,
    IncidentFromDate TEXT, IncidentToDate TEXT, InfoReceivedPSDate TEXT,
    latitude REAL, longitude REAL, BriefFacts TEXT);
CREATE TABLE ComplainantDetails(ComplainantID INT PRIMARY KEY, CaseMasterID INT, ComplainantName TEXT,
    AgeYear INT, OccupationID INT, ReligionID INT, CasteID INT, GenderID INT);
CREATE TABLE Victim(VictimMasterID INT PRIMARY KEY, CaseMasterID INT, VictimName TEXT, AgeYear INT,
    GenderID INT, VictimPolice TEXT);
CREATE TABLE Accused(AccusedMasterID INT PRIMARY KEY, CaseMasterID INT, AccusedName TEXT, AgeYear INT,
    GenderID TEXT, PersonID TEXT);
CREATE TABLE ArrestSurrender(ArrestSurrenderID INT PRIMARY KEY, CaseMasterID INT, ArrestSurrenderTypeID INT,
    ArrestSurrenderDate TEXT, ArrestSurrenderStateId INT, ArrestSurrenderDistrictId INT,
    PoliceStationID INT, IOID INT, CourtID INT, AccusedMasterID INT, IsAccused INT, IsComplainantAccused INT);
CREATE TABLE ActSectionAssociation(CaseMasterID INT, ActID TEXT, SectionID TEXT, ActOrderID INT, SectionOrderID INT);
CREATE TABLE ChargesheetDetails(CSID INT PRIMARY KEY, CaseMasterID INT, csdate TEXT, cstype TEXT, PolicePersonID INT);
""")

def ins(table, rows, n):
    if rows:
        cur.executemany(f"INSERT INTO {table} VALUES ({','.join('?'*n)})", rows)

ins("State", STATES, 4)
ins("District", DISTRICTS, 4)
ins("UnitType", UNIT_TYPES, 5)
ins("Unit", units, 8)
ins("Rank", RANKS, 4)
ins("Designation", DESIGNATIONS, 4)
ins("Employee", employees, 11)
ins("Court", courts, 5)
ins("CaseCategory", CASE_CATEGORY, 2)
ins("GravityOffence", GRAVITY, 2)
ins("CaseStatusMaster", CASE_STATUS, 2)
ins("ReligionMaster", RELIGION, 2)
ins("CasteMaster", CASTE, 2)
ins("OccupationMaster", OCCUPATION, 2)
ins("Act", ACTS, 4)
ins("Section", [(a, s, d, 1) for a, s, d in SECTIONS], 4)
ins("CrimeHead", CRIME_HEADS, 3)
ins("CrimeSubHead", CRIME_SUBHEADS, 4)
ins("CaseMaster", cases, 18)
ins("ComplainantDetails", complainants, 8)
ins("Victim", victims, 6)
ins("Accused", accused, 6)
ins("ArrestSurrender", arrests, 12)
ins("ActSectionAssociation", actsecs, 5)
ins("ChargesheetDetails", chargesheets, 5)

cur.executescript("""
CREATE INDEX idx_case_ps   ON CaseMaster(PoliceStationID);
CREATE INDEX idx_case_date ON CaseMaster(CrimeRegisteredDate);
CREATE INDEX idx_case_head ON CaseMaster(CrimeMajorHeadID);
CREATE INDEX idx_acc_case  ON Accused(CaseMasterID);
CREATE INDEX idx_acc_name  ON Accused(AccusedName);
CREATE INDEX idx_vic_case  ON Victim(CaseMasterID);
CREATE INDEX idx_as_case   ON ActSectionAssociation(CaseMasterID);
""")
con.commit()

# ---------------------------------------------------------------- CSV export

TABLES = ["State", "District", "UnitType", "Unit", "Rank", "Designation", "Employee",
          "Court", "CaseCategory", "GravityOffence", "CaseStatusMaster", "ReligionMaster",
          "CasteMaster", "OccupationMaster", "Act", "Section", "CrimeHead", "CrimeSubHead",
          "CaseMaster", "ComplainantDetails", "Victim", "Accused", "ArrestSurrender",
          "ActSectionAssociation", "ChargesheetDetails"]

for t in TABLES:
    cur.execute(f"SELECT * FROM {t}")
    cols = [d[0] for d in cur.description]
    with open(os.path.join(CSVD, f"{t}.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh); w.writerow(cols); w.writerows(cur.fetchall())

# ground truth (for evaluating entity resolution — keep out of the app)
clusters = {}
for row_id, p in truth.items():
    clusters.setdefault(str(p), []).append(row_id)
clusters = {k: v for k, v in clusters.items() if len(v) > 1}
with open(os.path.join(OUT, "truth.json"), "w", encoding="utf-8") as fh:
    json.dump({"clusters": clusters,
               "people": {str(p.pid): {"canonical": f"{p.first} {p.last}",
                                       "gender": p.gender, "birth_year": p.birth_year,
                                       "variants": p.variants} for p in people}},
              fh, indent=2, ensure_ascii=False)

# ---------------------------------------------------------------- report

print(f"SQLite : {db_path}")
print(f"CSVs   : {CSVD}/  ({len(TABLES)} tables)")
print(f"Truth  : {OUT}/truth.json\n")
for t in ["CaseMaster", "Accused", "Victim", "ComplainantDetails", "ArrestSurrender",
          "ActSectionAssociation", "ChargesheetDetails", "Unit", "Employee"]:
    cur.execute(f"SELECT COUNT(*) FROM {t}")
    print(f"  {t:<24} {cur.fetchone()[0]:>6}")

print(f"\n  Multi-appearance identities : {len(clusters)}")
print(f"  Accused rows to resolve     : {sum(len(v) for v in clusters.values())}")

big = sorted(clusters.items(), key=lambda x: -len(x[1]))[:3]
print("\n  --- Demo-ready identity clusters ---")
for p_id, rows in big:
    cur.execute(f"""SELECT a.AccusedName, a.AgeYear, u.UnitName, c.CrimeRegisteredDate
                    FROM Accused a JOIN CaseMaster c ON c.CaseMasterID=a.CaseMasterID
                    JOIN Unit u ON u.UnitID=c.PoliceStationID
                    WHERE a.AccusedMasterID IN ({','.join('?'*len(rows))})
                    ORDER BY c.CrimeRegisteredDate""", rows)
    rs = cur.fetchall()
    print(f"\n  person_{p_id}  ({len(rs)} records, one human):")
    for n, age, un, dt in rs:
        print(f"     {dt}  {n:<28} age {age:<3} {un}")

con.close()
