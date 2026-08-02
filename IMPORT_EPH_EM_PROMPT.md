# EPH and EM Import from Physical Model

## Overview
Import EPH (Equipment/Motor) and EM (Electric Motor) instances from a Physical Model document matrix into the app, similar to the IO import flow that populates CM instances.

## Input Format
A matrix structure where:
- **Rows**: Unit names (e.g., "Dissolving Vessel", "Filtration Vessel", etc.)
- **Columns**: EPH and EM function types (e.g., "EM_CIRCULATION_PUMP", "EM_PROCESS_MOD_DEV", etc.)
- **Cell Values**: "X" indicates the unit has that EPH/EM function

Example:
```
Description| EM_UPS | EM_PROCESS_MOD_DEV | EM_CIRCULATION_PUMP | EPH_DEVICE | ...
--------------------------|--------|-------------------|-------------------|-----------|-----
U01        |    X   |                   |        X          |     X     | ...
U02        |    X   |        X          |                   |           | ...
U03        |        |                   |        X          |           | ...
```

## Expected Behavior

### 1. Parse Matrix
- Read the Physical Model document matrix structure
- Extract unit names from rows
- Extract EPH/EM column headers
- Identify cells marked with "X"

### 2. Create Composite Instances
For each "X" found in the matrix:
- **Unit**: Row identifier (e.g., "Dissolving Vessel")
- **EPH/EM Type**: Column identifier (e.g., "EM_UPS")
- Create a composite instance of that type for the unit
- Place the composite in the appropriate folder hierarchy (e.g., `[Unit]/EM/` or `[Unit]/EPH/`)

### 3. Instance Naming Convention
Generate meaningful names for created composites:
- Use the EPH/EM column header as the base type
- Combine with unit name for clarity (e.g., "Dissolving_Vessel_EM_UPS")
- Ensure names are unique and traceable to source

### 4. Folder Placement
Similar to manual composite placement rules:
- Create instances under the unit's folder
- Use consistent subfolder structure: `[Unit]/[EM|EPH]/[Type]/`
- Follow existing hierarchy conventions from the app

### 5. Validation
- Verify unit names exist in the app
- Check EPH/EM types are valid/recognized
- Flag any discrepancies or missing units
- Provide import summary with created instances count

## Output
- List of created EPH/EM composite instances
- Folder locations where instances were placed
- Summary statistics (total processed, created, skipped)
- Error/warning report for unmapped units or invalid types

## Integration Notes
- Similar workflow to IO import (which populates CM instances)
- Use same column mapping infrastructure where applicable
- Support for bulk import via UI dialog or file upload
- Ability to preview before committing changes
