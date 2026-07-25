const { initDb, getDb } = require('./src/db');
const cfgGen = require('./src/services/cfgGenerator');
const fs = require('fs');

(async () => {
  await initDb();
  const db = getDb();

  // Get project data
  const project = db.prepare('SELECT * FROM projects WHERE id = 1').get();

  if (!project) {
    console.log('Project 1 not found');
    process.exit(1);
  }

  console.log(`Project: ${project.name}`);

  // Get stations
  const stations = db.prepare(`
    SELECT s.* FROM stations s
    WHERE s.project_id = 1
    ORDER BY s.address
  `).all();

  console.log(`\nStations: ${stations.length}`);
  stations.slice(0, 3).forEach(s => {
    console.log(`  ${s.address}: ${s.name}`);
  });

  // Get a station's slots
  if (stations.length > 0) {
    const st = stations[0];
    const slots = db.prepare(`
      SELECT s.*, t.order_no, t.signal_type FROM slots s
      LEFT JOIN hw_module_templates t ON s.template_id = t.id
      WHERE s.station_id = ?
      ORDER BY s.slot_number
    `).all(st.id);

    console.log(`\n\nStation ${st.address} slots (${slots.length}):`);
    slots.slice(0, 5).forEach(slot => {
      console.log(`  Slot ${slot.slot_number}: ${slot.order_no || 'empty'}`);

      // Check if this module has parameters
      if (slot.order_no && ['DI', 'DO', 'AI', 'AO'].includes(slot.signal_type)) {
        const pattern = slot.order_no.substring(0, slot.order_no.length - 6) + '%';
        const params = db.prepare(`
          SELECT COUNT(*) as cnt FROM hw_module_parameters p
          JOIN hw_module_templates t ON p.template_id = t.id
          WHERE t.signal_type = ? AND t.order_no LIKE ?
        `).get(slot.signal_type, pattern);

        if (params.cnt > 0) {
          console.log(`    → Has ${params.cnt} parameters`);
        }
      }
    });
  }

  console.log('\n\nTest complete');
})();
