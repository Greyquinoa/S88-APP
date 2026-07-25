"""Generate a hardware-style IO List with 1000 OnOff_Valve CMs.

Format matches the reference sheet:
  Subsystem_No | Station_Address | Station_Name | IP_Address | Router_Address |
  Slot | MLFB | Module_Name | Tag CM | Postfix | Tag | Description |
  Signal_Type | Channel | Hierarchy | Function | AS

Each OnOff_Valve CM produces 3 IO channels:
  _GSH  DI  "Open Limit"      -> a DI16 module
  _GSL  DI  "Closed Limit"    -> a DI16 module
  _OUT  DO  "Open Command"    -> a DQ16 module

Realistic packing:
  - DI channels fill DI16 modules (16 ch), DO channels fill DQ16 modules (16 ch).
  - When a module fills, a new slot is opened for that signal type.
  - When a station reaches its slot budget, a new station is opened (new
    address / name / IP), each starting with a slot-0 IM head row.
"""
import openpyxl

# ── Constants from the reference sheet ────────────────────────────────────────
SUBSYSTEM_NO   = 101
IM_MLFB        = "6ES7 155-6AU00-0CN0"
IM_NAME        = "IM155-6PN"
STATION_NAME   = "IM155-6PN-HF-V4.2"
ROUTER_ADDRESS = "192.168.1.3"
DI_MLFB, DI_NAME = "6ES7 131-6BH00-0BA0", "DI16"
DO_MLFB, DO_NAME = "6ES7 132-6BH00-0BA0", "DQ16"

CH_PER_MODULE     = 16     # DI16 / DQ16
SLOTS_PER_STATION = 8      # I/O slots per station before opening a new station
FUNCTION          = "OnOff_Valve"
AS_STATION        = "AS01"

TOTAL_CM = 1000

# Per-CM channel template: (postfix, signal_type, description)
CM_CHANNELS = [
    ("_GSH", "DI", "Open Limit"),
    ("_GSL", "DI", "Closed Limit"),
    ("_OUT", "DO", "Open Command"),
]

HEADERS = [
    "Subsystem_No", "Station_Address", "Station_Name", "IP_Address",
    "Router_Address", "Slot", "MLFB", "Module_Name", "Tag CM", "Postfix",
    "Tag", "Description", "Signal_Type", "Channel", "Hierarchy", "Function", "AS",
]


class Packer:
    """Streams IO rows into modules/slots/stations with realistic packing."""

    def __init__(self):
        self.rows = []
        self.station_idx = 0          # 0-based station counter
        self.slot_used = 0            # I/O slots consumed in current station
        # Active module per signal type: dict[sig] = {slot, channel}
        self.active = {}
        self._open_station()

    # ── station / IP helpers ─────────────────────────────────────────────────
    def _station_addr(self):
        return self.station_idx + 1
    def _station_ip(self):
        return f"192.168.1.{self.station_idx + 1}"

    def _open_station(self):
        self.slot_used = 0
        self.active = {}
        addr = self._station_addr()
        # Slot-0 IM head row for this station.
        self.rows.append([
            SUBSYSTEM_NO, addr, STATION_NAME, self._station_ip(),
            ROUTER_ADDRESS, 0, IM_MLFB, IM_NAME,
            "", "", "", "", "", "", "", "", "",
        ])

    def _next_slot(self):
        """Reserve a new I/O slot, opening a new station if the budget is hit."""
        if self.slot_used >= SLOTS_PER_STATION:
            self.station_idx += 1
            self._open_station()
        self.slot_used += 1
        # Slot numbering starts at 1 (slot 0 is the IM head).
        return self.slot_used

    def _module_for(self, sig):
        """Return the active module dict for this signal type, opening a fresh
        module (new slot) if none exists or the current one is full."""
        m = self.active.get(sig)
        if m is None or m["channel"] >= CH_PER_MODULE:
            slot = self._next_slot()
            m = {"slot": slot, "channel": 0}
            self.active[sig] = m
        return m

    def add_channel(self, tag_cm, postfix, sig, desc, hierarchy):
        m = self._module_for(sig)
        mlfb, name = (DI_MLFB, DI_NAME) if sig == "DI" else (DO_MLFB, DO_NAME)
        addr = self._station_addr()
        self.rows.append([
            SUBSYSTEM_NO, addr, STATION_NAME, self._station_ip(),
            "", m["slot"], mlfb, name,
            tag_cm, postfix, f"{tag_cm}{postfix}", desc, sig, m["channel"],
            hierarchy, FUNCTION, AS_STATION,
        ])
        m["channel"] += 1


def main():
    packer = Packer()
    for i in range(1, TOTAL_CM + 1):
        tag_cm = f"XV{i:03d}"
        unit = ((i - 1) % 10) + 1                 # DE1..DE10
        hierarchy = f"rIX/DE{unit}/U{unit:03d}/CM"
        valve_no = i
        for postfix, sig, desc in CM_CHANNELS:
            packer.add_channel(
                tag_cm, postfix, sig,
                f"Valve {valve_no} {desc}", hierarchy,
            )

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "HW_IO_List"
    ws.append(HEADERS)
    for r in packer.rows:
        ws.append(r)

    out = "Sample_HW_IOList_1000CM.xlsx"
    wb.save(out)

    io_rows = len(packer.rows) - (packer.station_idx + 1)  # minus IM head rows
    print(f"Wrote {out}")
    print(f"  CMs:          {TOTAL_CM}")
    print(f"  Stations:     {packer.station_idx + 1}")
    print(f"  Total rows:   {len(packer.rows)} (incl {packer.station_idx + 1} IM heads)")
    print(f"  IO channels:  {io_rows}")


if __name__ == "__main__":
    main()
