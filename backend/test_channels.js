const { initDb, getDb } = require('./src/db');

(async () => {
  await initDb();
  const db = getDb();

  // Get ET200SP IO cards
  const cards = db.prepare(`
    SELECT id, order_no, signal_type, channel_count, description
    FROM hw_module_templates
    WHERE signal_type IN ('DI', 'DO', 'AI', 'AO')
    ORDER BY order_no
    LIMIT 10
  `).all();

  console.log('IO Cards:\n');
  cards.forEach(c => {
    console.log(`${c.order_no} (${c.signal_type})`);
    console.log(`  Channel count: ${c.channel_count}`);
    console.log(`  Description: ${c.description}\n`);
  });

  // Check a specific station's slots
  console.log('\n\nStation 1 slots with channels:\n');
  const slots = db.prepare(`
    SELECT s.id, s.slot_number, t.order_no, t.channel_count,
           COUNT(DISTINCT sc.channel) as loaded_channels
    FROM slots s
    LEFT JOIN hw_module_templates t ON s.template_id = t.id
    LEFT JOIN slot_channels sc ON sc.slot_id = s.id
    WHERE s.station_id = 1
    GROUP BY s.id
    LIMIT 10
  `).all();

  slots.forEach(s => {
    console.log(`Slot ${s.slot_number}: ${s.order_no}`);
    console.log(`  Template channel_count: ${s.channel_count}`);
    console.log(`  Loaded channels: ${s.loaded_channels}\n`);
  });
})();
