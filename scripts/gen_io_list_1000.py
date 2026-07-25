"""Generate a test IO List with 1000 CM instruments for import into the
IO Import → Upload step. Columns match the auto-detected header aliases:
  Instrument  -> instrument_tag  (CM identity, e.g. XV0001)
  Function    -> function_val    (maps to a CM type via Function Mapping)
  Hierarchy   -> hierarchy       (folder path, e.g. rIX/DE01)
  Assignment  -> assignment      (AS station, e.g. AS01)
Plus Description / Signal_Type for readability.
"""
import openpyxl

# Function values seen in the Function Mapping tab. The tag prefix mirrors the
# usual instrument-letter convention so the list reads realistically.
FUNCTIONS = [
    ("CONTROLVALVE", "FV", "AO",  "Control Valve"),
    ("ONOFF_VALVE",  "XV", "DO",  "On/Off Valve"),
    ("ESTARTER",     "M",  "DO",  "Motor Starter"),
    ("SWITCH",       "ZS", "DI",  "Limit Switch"),
    ("TRANSMITTER",  "FT", "AI",  "Transmitter"),
]

TOTAL = 1000
HEADERS = ["Instrument", "Function", "Hierarchy", "Assignment", "Description", "Signal_Type"]

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "IO_List"
ws.append(HEADERS)

# Spread instruments across 10 units (DE01..DE10) under a common area "rIX",
# and across two AS stations so the AS-assignment mapping has something to do.
for i in range(1, TOTAL + 1):
    fn_name, prefix, sig, desc = FUNCTIONS[(i - 1) % len(FUNCTIONS)]
    unit = ((i - 1) % 10) + 1          # DE01..DE10
    as_no = 1 if i <= TOTAL // 2 else 2  # AS01 for first half, AS02 for second
    tag = f"{prefix}{i:04d}"
    ws.append([
        tag,
        fn_name,
        f"rIX/DE{unit:02d}",
        f"AS{as_no:02d}",
        f"{desc} {i}",
        sig,
    ])

# A short Info sheet documenting the columns.
info = wb.create_sheet("Info")
info.append(["Column", "Description"])
info.append(["Instrument", "CM identity tag (unique per instance)"])
info.append(["Function", "Function value -> mapped to a CM type in Function Mapping"])
info.append(["Hierarchy", "Folder path (Area/Unit) -> hierarchy folders"])
info.append(["Assignment", "AS station (e.g. AS01) -> user project"])
info.append(["Description", "Human-readable label"])
info.append(["Signal_Type", "Primary signal type (informational)"])

out = "Sample_IOList_1000CM.xlsx"
wb.save(out)

# Quick summary
from collections import Counter
counts = Counter(FUNCTIONS[(i - 1) % len(FUNCTIONS)][0] for i in range(1, TOTAL + 1))
print(f"Wrote {out} with {TOTAL} instruments")
for fn, c in counts.items():
    print(f"  {fn}: {c}")
