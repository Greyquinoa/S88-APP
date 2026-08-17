export const ROUTES = {
  PROJECTS: '/projects',
  IO_IMPORT: '/io-import',
  EPH_EM_IMPORT: '/eph-em-import',
  LIBRARY: '/library',
  UNIT_TYPES: '/unit-types',
  HIERARCHY: '/hierarchy',
  INSTANCES: '/instances',
  HW_CONFIG: '/hw-config',
  GENERATE: '/generate',
};

export const ROUTE_TO_STEP = {
  '/projects': 0,
  '/io-import': 1,
  '/eph-em-import': 2,
  '/library': 3,
  '/unit-types': 4,
  '/hierarchy': 5,
  '/instances': 6,
  '/hw-config': 7,
  '/generate': 8,
};

export const STEP_TO_ROUTE = {
  0: '/projects',
  1: '/io-import',
  2: '/eph-em-import',
  3: '/library',
  4: '/unit-types',
  5: '/hierarchy',
  6: '/instances',
  7: '/hw-config',
  8: '/generate',
};
