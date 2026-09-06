# Catalogue Export/Import - UI Visual Guide

## Layout

### Before Clicking Export/Import Button
```
┌─────────────────────────────────────────────────────┐
│  Grid/Family Toggle    Search    Count    [Buttons]  │  ← Toolbar
├─────────────────────────────────────────────────────┤
│                                                       │
│                 Module Templates Grid                │
│                   (station/slot/subslot)            │
│                                                       │
│  - Order No  - Display Name  - Category  - Actions   │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### After Clicking Export/Import Button
```
┌─────────────────────────────────────────────────────┐
│  Grid/Family Toggle    Search    Count    [Buttons]  │
├─────────────────────────────────────────────────────┤
│  Catalogue Export/Import                       [×]   │
├─────────────────────────────────────────────────────┤
│                                                       │
│  ▼ Export Catalogue                                  │
│  Downloads a single JSON file containing all         │
│  module templates, slot compatibility rules,         │
│  signal types, and module parameters.               │
│                                                       │
│  [📥 Export Catalogue]                              │
│                                                       │
│  ▼ Import Catalogue                                  │
│  Upload a previously exported catalogue file.        │
│  You'll be able to review differences and choose     │
│  exactly what to import.                             │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │                    📤                            │ │
│  │   Drop catalogue export (.json) here             │ │
│  │            or click to browse                    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### After Selecting File (Preview View)
```
┌─────────────────────────────────────────────────────┐
│  Catalogue Export/Import                       [×]   │
├─────────────────────────────────────────────────────┤
│                                                       │
│  Source exported: Sep 2, 2026, 10:30 AM             │
│  42 templates, 15 slot compat rules, 8 signal types  │
│                                                       │
│  ▼ Module Templates                                  │
│  ┌────────┬─────────┬─────────┬──────────┐          │
│  │ New    │ Updated │ Unchanged│ Removed │          │
│  │  5     │  3      │  34      │  0      │          │
│  └────────┴─────────┴─────────┴──────────┘          │
│                                                       │
│  [All] [New] [Updated] [Unchanged] [Removed]        │
│  [Select all in view]  [Deselect all]               │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ☑ S7-1200 PLC (6ES7511...)      [Updated] ▼     │ │
│  │ ☑ DI Module (6ES7135...)         [New]          │ │
│  │ ☐ DO Module (6ES7136...)         [Unchanged]    │ │
│  │ ☑ AI Module (6ES7137...)         [New]          │ │
│  │                                                  │ │
│  │                           [scroll more...]        │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ▼ Slot Compatibility Rules                          │
│  ┌────────┬─────────┬─────────┬──────────┐          │
│  │ New    │ Updated │ Unchanged│ Removed │          │
│  │  2     │  0      │  13      │  0      │          │
│  └────────┴─────────┴─────────┴──────────┘          │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ☑ S7-1200 → DI Module           [New]          │ │
│  │ ☑ S7-1200 → AI Module           [New]          │ │
│  │ ☐ S7-1200 → DO Module           [Unchanged]    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ▼ Signal Types                                      │
│  ┌────────┬─────────┬─────────┬──────────┐          │
│  │ New    │ Updated │ Unchanged│ Removed │          │
│  │  1     │  0      │  7       │  0      │          │
│  └────────┴─────────┴─────────┴──────────┘          │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ☑ CUSTOM_TYPE                   [New]          │ │
│  │ ☐ DI                              [Unchanged]    │ │
│  │ ☐ DO                              [Unchanged]    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│                          [Cancel]  [Import selected] │
│                                         (8 items)    │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### After Successful Import
```
┌─────────────────────────────────────────────────────┐
│  Catalogue Export/Import                       [×]   │
├─────────────────────────────────────────────────────┤
│                                                       │
│  ▼ Export Catalogue                                  │
│  Downloads a single JSON file containing all         │
│  module templates, slot compatibility rules,         │
│  signal types, and module parameters.               │
│                                                       │
│  [📥 Export Catalogue]                              │
│                                                       │
│  ▼ Import Catalogue                                  │
│  Upload a previously exported catalogue file.        │
│                                                       │
│  ✅ Import complete — Templates: 5 new, 3 updated,  │
│     34 skipped. Slot Compat: 2 new, 13 skipped.    │
│     Signal Types: 1 new, 7 skipped.                │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │                    📤                            │ │
│  │   Drop catalogue export (.json) here             │ │
│  │            or click to browse                    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
└─────────────────────────────────────────────────────┘
```

## Status Badge Colors

| Status | Background | Text | Meaning |
|--------|-----------|------|---------|
| **NEW** | Green (#DCFCE7) | Dark green (#166534) | Item doesn't exist in DB, will be created |
| **UPDATED** | Blue (#DBEAFE) | Dark blue (#1D4ED8) | Item exists but differs, will be updated |
| **UNCHANGED** | Gray (#F3F4F6) | Medium gray (#6B7280) | Item exists and is identical, won't change |
| **REMOVED_FROM_FILE** | Yellow (#FEF3C7) | Brown (#92400E) | Item exists in DB but not in export file |

## Interaction Details

### Summary Cards
```
┌──────────────┐
│ NEW          │
│              │
│   5          │
└──────────────┘
```
Shows count per category and status filter.

### Filter Buttons
```
[All] [New] [Updated] [Unchanged] [Removed]
```
- Click to filter items shown below
- Active button has darker background

### Item Row
```
☑  S7-1200 PLC (6ES7511-1AK02-0AB0)         [Updated] ▼
```
- Checkbox: selected/unselectable (disabled if UNCHANGED/REMOVED)
- Name/ID: identifies the item
- Status badge: color-coded status
- Details button (▼): shows what changed (if UPDATED)

### Select/Deselect Controls
```
[Select all in view]  [Deselect all]
```
- Works on filtered items only
- Respects disabled items (UNCHANGED, REMOVED)

### Action Buttons
```
[Cancel]  [Import selected (8)]
```
- Cancel: returns to idle state, clears preview
- Import: disabled if no items selected, shows count

## Error States

### Invalid File
```
❌ Error: Invalid JSON format
```

### Empty Import
```
⚠️  No items selected. Please select at least one item to import.
```
(Import button disabled)

## Loading States

```
📤 Parsing file…
```

```
⏳ Importing…
```

## Responsive Behavior

- Panel appears full-width above grid
- Scrollable content (500px max-height for lists)
- Collapsible sections for each category
- Works on tablet (categories may stack vertically)
- Buttons wrap on narrow screens

## Keyboard Shortcuts

- ×: Close panel (button click)
- ↑/↓: Scroll through items
- Space: Toggle checkbox for focused item
- Tab: Navigate between elements

## Accessibility

- All buttons have clear labels
- Color not sole indicator (status badges have text labels)
- Sufficient color contrast (WCAG AA compliant)
- Form controls labeled
- Error messages clear and actionable
