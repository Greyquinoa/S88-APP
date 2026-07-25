process.env.DB_PATH = './data/pcs7_library.db';
const path = require('path');
process.chdir('./backend');

(async () => {
  const { initDb, ensureSchema, getDb } = require('./src/db');
  await initDb();
  ensureSchema();

  const db = getDb();
  const ModuleParameterExtractor = require('./src/services/moduleParameterExtractor');
  const ModuleParameterDb = require('./src/services/moduleParameterDb');

  // Pick an AI template that has a param_template
  const tpl = db.prepare(
    "SELECT id, order_no, param_template FROM hw_module_templates WHERE param_template IS NOT NULL AND param_template != '' LIMIT 3"
  ).all();

  console.log(`Templates with param_template: ${tpl.length}`);
  for (const t of tpl) {
    const ex = new ModuleParameterExtractor();
    const params = ex.parseParamTemplate(t.param_template);
    ModuleParameterDb.deleteParametersForTemplate(t.id);
    const n = ModuleParameterDb.insertModuleParameters(t.id, params);
    console.log(`  template ${t.id} (${t.order_no}): parsed ${params.length}, inserted ${n}`);
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM hw_module_parameters').get();
  console.log(`\nTotal hw_module_parameters rows: ${total.n}`);

  // Show a sample
  const sample = db.prepare('SELECT template_id, parameter_name, channel_no, parameter_type, parameter_value FROM hw_module_parameters LIMIT 8').all();
  console.table(sample);
})();
